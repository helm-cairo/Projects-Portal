/* Helm Portal — data layer shared by both apps.
 *
 * Both apps were written against a small document database API:
 *   db.doc('cases/c001').set(obj) / .update(patch) / .delete() / .get() / .onSnapshot(fn)
 *   db.collection('cases').where('period','>=','2026-01').orderBy('at','desc').limit(300)
 *     .get() / .onSnapshot(fn)   -> snapshot { docs, size, empty, docChanges() }
 * This file keeps that API and stores everything in Supabase tables named
 * "<system>_<collection>" (e.g. cases_cases, attendance_students), each with a
 * jsonb "data" column. Every request runs as the signed-in user, so the RLS
 * rules in the database decide what is visible or writable.
 *
 * Live updates: each listener subscribes to Supabase Realtime for its table(s)
 * and re-reads the changed row by id, so filters and RLS stay correct.
 */
(function () {
  'use strict';

  function rid() { return Math.random().toString(36).slice(2, 10); }

  function dbErr(error) {
    var e = new Error((error && error.message) || 'db error');
    var c = error && error.code;
    e.code = c === '23505' ? 'duplicate'
      : (c === '42501' || /row-level security|permission denied/i.test(e.message)) ? 'permission'
      : (c === 'PGRST301' || /JWT/i.test(e.message)) ? 'session'
      : c === 'P0002' ? 'not_found'
      : c === '22023' ? 'invalid'
      : 'upstream_error';
    e.raw = error;
    return e;
  }

  function snapDoc(id, data) {
    return { id: id, exists: data != null, data: function () { return data == null ? undefined : data; } };
  }

  /**
   * opts.system   'cases' | 'attendance'  (table prefix)
   * opts.views    { collection: { read: 'view_name', watch: ['table', ...], key: { table: 'column' } } }
   * opts.beforeWrite(collection, data) -> data   (strip fields that must not be sent)
   */
  function create(sb, opts) {
    var prefix = opts.system + '_';
    var views = opts.views || {};
    var beforeWrite = opts.beforeWrite || function (c, d) { return d; };

    function tableOf(coll) { return prefix + coll; }
    function readOf(coll) { return (views[coll] && views[coll].read) || tableOf(coll); }
    function watchOf(coll) { return (views[coll] && views[coll].watch) || [tableOf(coll)]; }
    function keyOf(coll, table) { var k = views[coll] && views[coll].key; return (k && k[table]) || 'id'; }

    // Open listeners per collection. After this browser saves something, every
    // listener re-reads that record right away, so our own changes always show,
    // even if a live-update message from the server arrives late or not at all.
    var listeners = {};
    function notify(coll, id) {
      (listeners[coll] || []).forEach(function (fn) { fn(id); });
    }

    function clean(coll, data) {
      var d = Object.assign({}, data);
      delete d.id;
      return beforeWrite(coll, d);
    }

    // ---------- single document ----------
    function doc(path) {
      var parts = String(path).split('/');
      var coll = parts[0], id = parts.slice(1).join('/');
      var ref = {
        id: id,
        get: async function () {
          var r = await sb.from(readOf(coll)).select('id,data').eq('id', id).maybeSingle();
          if (r.error) throw dbErr(r.error);
          return snapDoc(id, r.data ? r.data.data : null);
        },
        set: async function (obj) {
          var r = await sb.from(tableOf(coll)).upsert({ id: id, data: clean(coll, obj) });
          if (r.error) throw dbErr(r.error);
          notify(coll, id);
        },
        update: async function (patch) {
          var r = await sb.rpc('helm_patch_doc', { p_table: tableOf(coll), p_id: id, p_patch: clean(coll, patch) });
          if (r.error) throw dbErr(r.error);
          notify(coll, id);
        },
        delete: async function () {
          var r = await sb.from(tableOf(coll)).delete().eq('id', id);
          if (r.error) throw dbErr(r.error);
          notify(coll, id);
        },
        onSnapshot: function (next, onErr) {
          var ch = sb.channel('d-' + coll + '-' + rid());
          watchOf(coll).forEach(function (t) {
            ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, function (p) {
              var row = p.new && Object.keys(p.new).length ? p.new : p.old;
              if (row && row[keyOf(coll, t)] === id) ref.get().then(next, function (e) { onErr && onErr(e); });
            });
          });
          ch.subscribe();
          ref.get().then(next, function (e) { onErr && onErr(e); });
          return function () { sb.removeChannel(ch); };
        }
      };
      return ref;
    }

    // ---------- queries ----------
    function query(coll, q) {
      q = q || { filters: [], order: null, lim: null };
      function withF(f) { return query(coll, Object.assign({}, q, f)); }

      function applyFilters(b) {
        q.filters.forEach(function (f) {
          var col = 'data->>' + f[0], op = f[1], v = f[2];
          b = op === '==' ? b.eq(col, v) : op === '>=' ? b.gte(col, v) : op === '<=' ? b.lte(col, v)
            : op === '>' ? b.gt(col, v) : op === '<' ? b.lt(col, v) : op === 'in' ? b.in(col, v) : b;
        });
        return b;
      }
      function matches(data) {
        return q.filters.every(function (f) {
          var x = data ? data[f[0]] : undefined, op = f[1], v = f[2];
          return op === '==' ? x === v : op === '>=' ? x >= v : op === '<=' ? x <= v
            : op === '>' ? x > v : op === '<' ? x < v : op === 'in' ? v.indexOf(x) >= 0 : true;
        });
      }
      function sortDocs(list) {
        if (q.order) {
          var f = q.order[0], desc = q.order[1] === 'desc';
          list.sort(function (a, b) {
            var x = a.data()[f], y = b.data()[f];
            if (x === y) return 0;
            if (x == null) return 1;
            if (y == null) return -1;
            return (x < y ? -1 : 1) * (desc ? -1 : 1);
          });
        }
        return q.lim ? list.slice(0, q.lim) : list;
      }
      async function fetchAll() {
        var out = [];
        var pageSize = 1000;
        for (var from = 0; ; from += pageSize) {
          var b = applyFilters(sb.from(readOf(coll)).select('id,data'));
          if (q.order) b = b.order('data->>' + q.order[0], { ascending: q.order[1] !== 'desc', nullsFirst: false });
          else b = b.order('id');
          var to = from + pageSize - 1;
          if (q.lim) to = Math.min(to, q.lim - 1);
          var r = await b.range(from, to);
          if (r.error) throw dbErr(r.error);
          out.push.apply(out, r.data);
          if (r.data.length < pageSize || (q.lim && out.length >= q.lim)) break;
        }
        return out;
      }
      function snapshotOf(map, changes) {
        var docs = sortDocs(Array.from(map.values()));
        return { docs: docs, size: docs.length, empty: !docs.length, docChanges: function () { return changes; } };
      }

      return {
        where: function (f, op, v) { return withF({ filters: q.filters.concat([[f, op, v]]) }); },
        orderBy: function (f, dir) { return withF({ order: [f, dir || 'asc'] }); },
        limit: function (n) { return withF({ lim: n }); },
        doc: function (id) { return doc(coll + '/' + id); },
        get: async function () {
          var rows = await fetchAll();
          var map = new Map();
          rows.forEach(function (r) { map.set(r.id, snapDoc(r.id, r.data)); });
          return snapshotOf(map, []);
        },
        onSnapshot: function (next, onErr) {
          var map = new Map(), ready = false, queue = [], stopped = false;
          async function refetch(id) {
            var b = applyFilters(sb.from(readOf(coll)).select('id,data').eq('id', id));
            var r = await b.maybeSingle();
            if (r.error) throw dbErr(r.error);
            var changes = [];
            if (r.data && matches(r.data.data)) {
              changes.push({ type: map.has(id) ? 'modified' : 'added', doc: snapDoc(id, r.data.data) });
              map.set(id, snapDoc(id, r.data.data));
            } else if (map.has(id)) {
              changes.push({ type: 'removed', doc: map.get(id) });
              map.delete(id);
            }
            if (changes.length && !stopped) next(snapshotOf(map, changes));
          }
          function handle(table, p) {
            var row = p.new && Object.keys(p.new).length ? p.new : p.old;
            var id = row && row[keyOf(coll, table)];
            if (!id) return;
            refetch(id).catch(function (e) { onErr && onErr(e); });
          }
          function onLocalWrite(id) {
            if (ready) refetch(id).catch(function (e) { onErr && onErr(e); });
            else queue.push([null, { new: { id: id } }]);
          }
          (listeners[coll] = listeners[coll] || []).push(onLocalWrite);
          var ch = sb.channel('q-' + coll + '-' + rid());
          watchOf(coll).forEach(function (t) {
            ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, function (p) {
              if (ready) handle(t, p); else queue.push([t, p]);
            });
          });
          ch.subscribe(function (st) {
            if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && onErr) onErr(new Error('realtime ' + st));
          });
          fetchAll().then(function (rows) {
            var changes = rows.map(function (r) {
              var d = snapDoc(r.id, r.data);
              map.set(r.id, d);
              return { type: 'added', doc: d };
            });
            if (!stopped) next(snapshotOf(map, changes));
            ready = true;
            queue.splice(0).forEach(function (x) { handle(x[0], x[1]); });
          }, function (e) { onErr && onErr(e); });
          return function () {
            stopped = true;
            listeners[coll] = (listeners[coll] || []).filter(function (fn) { return fn !== onLocalWrite; });
            sb.removeChannel(ch);
          };
        }
      };
    }

    return {
      doc: doc,
      collection: function (name) { return query(name); }
    };
  }

  // Save a file on the viewer's device (replaces the old "downloads" helper).
  function download(filename, data, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  window.HelmDB = { create: create, download: download, dbErr: dbErr };
})();
