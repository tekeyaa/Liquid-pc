# Временный разбор трасс замера (perf.spec.js, опыт ab v7): занятость процессов и потоков по режимам.
import glob, json, os, sys
from collections import defaultdict
from perfetto.trace_processor import TraceProcessor

d = sys.argv[1] if len(sys.argv) > 1 else 'perftrace'
busy = defaultdict(lambda: defaultdict(float))
names = defaultdict(lambda: defaultdict(float))
runs = defaultdict(int)
for f in sorted(glob.glob(os.path.join(d, '*.pftrace'))):
    mode = 'normal' if f.endswith('normal.pftrace') else 'noupd'
    runs[mode] += 1
    pids = {}
    try:
        for x in json.load(open(f.replace('-normal.pftrace', '-pids.json').replace('-noupd.pftrace', '-pids.json'))):
            pids[x['pid']] = ('окно' if x['t'] == 'window' else 'вкладка ' + x['u'].split('/')[-1][:12])
    except Exception:
        pass
    tp = TraceProcessor(trace=f)
    who = lambda r: f"{pids.get(r.pid) or r.pname}/{r.tname}"
    for r in tp.query("""select p.pid as pid, coalesce(p.name, '') as pname, coalesce(t.name, '') as tname, sum(s.dur) / 1e6 as ms
        from slice s join thread_track tt on s.track_id = tt.id join thread t using(utid) left join process p using(upid)
        where s.depth = 0 group by 1, 2, 3"""):
        busy[mode][who(r)] += r.ms
    for r in tp.query("""select p.pid as pid, coalesce(p.name, '') as pname, coalesce(t.name, '') as tname, s.name as name, sum(s.dur) / 1e6 as ms
        from slice s join thread_track tt on s.track_id = tt.id join thread t using(utid) left join process p using(upid)
        where s.depth between 1 and 3 group by 1, 2, 3, 4"""):
        names[mode][who(r) + ' ' + r.name] += r.ms
    tp.close()
for mode in ('normal', 'noupd'):
    n = max(runs[mode], 1)
    top = sorted(busy[mode].items(), key=lambda x: -x[1])[:14]
    print(f"[трасса {mode}, мс на прогон из 4 загрузок] " + ' | '.join(f"{k}: {v / n:.0f}" for k, v in top))
# разница по именам: что в «обычном» занимает больше, чем «без updateTab»
diff = {k: (names['normal'][k] / max(runs['normal'], 1)) - (names['noupd'].get(k, 0) / max(runs['noupd'], 1)) for k in names['normal']}
print('[трасса: больше в обычном] ' + ' | '.join(f"{k}: +{v:.0f}" for k, v in sorted(diff.items(), key=lambda x: -x[1])[:25]))
bd = {k: busy['normal'][k] / max(runs['normal'], 1) - busy['noupd'].get(k, 0) / max(runs['noupd'], 1) for k in busy['normal']}
print('[трасса: потоки, больше в обычном] ' + ' | '.join(f"{k}: +{v:.0f}" for k, v in sorted(bd.items(), key=lambda x: -x[1])[:14]))
