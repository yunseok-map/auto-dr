// UTF-8 안전하게 A/B 비교 시작(Node 네이티브 FormData/fetch).
const fd = new FormData();
fd.append('source', 'C:/Users/A/Desktop/auto_dr/.preview/sample_ab.md');
fd.append('focusA', '');
fd.append('labelA', '종합 균형');
fd.append('modelA', 'haiku');
fd.append('focusB', '문장 명료성·논리 구조·일관성·간결성을 최우선으로 개선하라.');
fd.append('labelB', '명료성 집중');
fd.append('modelB', 'haiku');
fd.append('maxIter', '1');
fd.append('maxTotalCostUsd', '0.2');
const r = await fetch('http://localhost:4517/api/compare', { method: 'POST', body: fd });
console.log(await r.text());
