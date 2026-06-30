// 간단한 LCS 기반 unified diff 생성기(코드 리뷰 결과를 패치 형태로 보여주기 위함).
// 외부 의존성 없이 라인 단위로 동작. 매우 큰 입력은 호출부에서 건너뛴다.

export function unifiedDiff(original: string, improved: string, fileLabel = 'artifact', context = 3): string {
  const a = original.replace(/\r\n/g, '\n').split('\n');
  const b = improved.replace(/\r\n/g, '\n').split('\n');
  const ops = diffOps(a, b);
  if (!ops.some((o) => o.t !== 'eq')) return ''; // 변경 없음

  // 변경 위치 주변 context 줄만 묶어 hunk 로 출력.
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === 'eq') {
      i++;
      continue;
    }
    // 변경 시작 → context 만큼 앞으로 확장
    let start = Math.max(0, i - context);
    let end = i;
    // 변경 + 사이의 작은 eq 구간(<= 2*context)을 같은 hunk 로 병합
    while (end < ops.length) {
      if (ops[end].t !== 'eq') {
        end++;
        continue;
      }
      let run = end;
      while (run < ops.length && ops[run].t === 'eq') run++;
      if (run - end > context * 2 || run >= ops.length) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end = run;
    }
    const slice = ops.slice(start, end);
    let aStart = slice[0].ai + 1;
    let bStart = slice[0].bi + 1;
    let aCount = slice.filter((o) => o.t !== 'add').length;
    let bCount = slice.filter((o) => o.t !== 'del').length;
    if (aCount === 0) aStart = (slice[0].ai || 0); // 빈 경우 보정
    if (bCount === 0) bStart = (slice[0].bi || 0);
    const body = slice
      .map((o) => (o.t === 'eq' ? ' ' + o.line : o.t === 'del' ? '-' + o.line : '+' + o.line))
      .join('\n');
    hunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@\n${body}`);
    i = end;
  }
  if (!hunks.length) return '';
  return `--- a/${fileLabel}\n+++ b/${fileLabel}\n${hunks.join('\n')}\n`;
}

interface Op { t: 'eq' | 'del' | 'add'; line: string; ai: number; bi: number; }

// LCS 백트래킹으로 eq/del/add 연산 시퀀스 생성.
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // DP 테이블(O(n*m)). 호출부에서 큰 입력은 막으므로 여기선 단순 구현.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', line: a[i], ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', line: a[i], ai: i, bi: j });
      i++;
    } else {
      ops.push({ t: 'add', line: b[j], ai: i, bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'del', line: a[i], ai: i++, bi: j });
  while (j < m) ops.push({ t: 'add', line: b[j], ai: i, bi: j++ });
  return ops;
}
