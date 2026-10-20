from pathlib import Path
import json, html
root=Path('/Users/mac1178/Documents/github.com/EdwardShen125/edwardshen125.github.io')
base=root/'diagrams/running-a-million-dau-casual-game-on-go-rooms-as-the-concurrency-boundary-c4'
asset=root/'source/_posts/engineering-case-study/running-a-million-dau-casual-game-on-go-rooms-as-the-concurrency-boundary'
W,H=1500,1030
nodes=[
('clients',40,350,220,150,'Game clients',['Player commands','Per-view state updates'],'#356a8a'),
('conn',330,350,240,150,'Connection layer',['Game protocol','Batch inputs per tick'],'#356a8a'),
('scheduler',330,130,240,130,'Fleet scheduler',['Track instance load','Place new rooms'],'#64748b'),
('pool',660,130,360,130,'Room pool',['Pre-allocate and reuse rooms','Match player level and intent'],'#64748b'),
('rooms',660,350,360,270,'Room goroutines',['One owner of mutable state per room','50 ms interval / 20 Hz','Serial systems query matching entities','Entity-indexed component arrays','Room population caps'],'#8a6d3b'),
('aoi',1130,350,300,150,'AOI broadcast',['Filter changes by player visibility','Bound fanout within each room'],'#356a8a'),
('snapshot',1130,700,300,130,'Async snapshots',['Periodic flush outside the tick','Recent updates may be lost'],'#a44a3f'),
('mongo',1130,900,300,90,'MongoDB',['Restore last persisted snapshot'],'#a44a3f')]
edges=[('commands',[(260,400),(330,400)],'cmds',280,382),('input',[(570,425),(660,425)],'input batch',582,407),('placement',[(570,195),(660,195)],'place',595,177),('lifecycle',[(840,260),(840,350)],'assign / recycle',860,305),('changes',[(1020,425),(1130,425)],'changes',1040,407),('updates',[(1280,500),(1280,660),(150,660),(150,500)],'view updates',350,645),('snapshot',[(930,620),(930,765),(1130,765)],'snapshot',960,747),('flush',[(1280,830),(1280,900)],'flush',1300,870)]
parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="context-stroke"/></marker></defs>', '<rect width="100%" height="100%" fill="#fbfcfe"/>','<style>text{font-family:Arial,Helvetica,sans-serif;fill:#203047}.title{font-size:28px;font-weight:700}.sub{font-size:17px;fill:#526278}.node{font-size:21px;font-weight:700}.body{font-size:17px}.edge{font-size:15px;fill:#475569}</style>', '<text x="40" y="45" class="title">Rooms own state; systems run serially inside each room</text>', '<text x="40" y="78" class="sub">Go schedules independent room goroutines across available processors</text>', '<rect x="300" y="290" width="1160" height="560" rx="18" fill="#f0f4f8" stroke="#9aa9b8" stroke-dasharray="8 5"/>','<text x="325" y="320" class="sub">One Go server instance · repeated across the fleet</text>']
for eid,points,label,lx,ly in edges:
 color='#a44a3f' if eid in ['snapshot','flush'] else '#64748b' if eid in ['placement','lifecycle'] else '#356a8a'
 d='M '+' L '.join(f'{x} {y}' for x,y in points)
 parts.append(f'<path id="{eid}" d="{d}" fill="none" stroke="{color}" stroke-width="2.5" marker-end="url(#arrow)"/>')
 parts.append(f'<text x="{lx}" y="{ly}" class="edge">{label}</text>')
for id,x,y,w,h,title,lines,color in nodes:
 parts.append(f'<g id="{id}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="white" stroke="{color}" stroke-width="2"/>')
 parts.append(f'<text x="{x+18}" y="{y+34}" class="node">{html.escape(title)}</text>')
 for i,line in enumerate(lines):parts.append(f'<text x="{x+18}" y="{y+65+i*30}" class="body">{html.escape(line)}</text>')
 parts.append('</g>')
parts.append('<text x="40" y="1008" class="sub">Observed fleet: 20+ instances · ~200,000 peak concurrent players · over one million DAU</text></svg>')
svg='\n'.join(parts)
base.with_suffix('.svg').write_text(svg)
(asset/'architecture.svg').write_text(svg)
spec=json.loads(base.with_suffix('.json').read_text())
spec.update(width=W,height=H,title='Rooms own state; systems run serially inside each room',subtitle='Go schedules independent room goroutines across available processors')
spec['nodes']=[dict(id=id,x=x,y=y,width=w,height=h,label=title,description='; '.join(lines),stroke=c) for id,x,y,w,h,title,lines,c in nodes]
spec['arrows']=[dict(id=id,points=points,label=label,label_x=x,label_y=y) for id,points,label,x,y in edges]
spec['renderer']='diagrams/tools/render-game-room-diagram.py'
base.with_suffix('.json').write_text(json.dumps(spec,indent=2)+'\n')
layout=dict(canvas=dict(width=W,height=H),nodes=spec['nodes'],edges=spec['arrows'])
# Check every orthogonal edge against non-endpoint box interiors.
violations=[]
for eid,points,*_ in edges:
 for (ax,ay),(bx,by) in zip(points,points[1:]):
  for id,x,y,w,h,*_ in nodes:
   if ax==bx and x<ax<x+w and max(min(ay,by),y)<min(max(ay,by),y+h):violations.append((eid,id))
   if ay==by and y<ay<y+h and max(min(ax,bx),x)<min(max(ax,bx),x+w):violations.append((eid,id))
assert not violations,violations
layout['validation']={'edge_node_intersections':0,'orthogonal_edges':True}
base.with_suffix('.layout.json').write_text(json.dumps(layout,indent=2)+'\n')
print(base.with_suffix('.svg'))
