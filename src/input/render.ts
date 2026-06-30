// Playwright 헤드리스 렌더링 — SPA 등 JS 로 그려지는 페이지의 "실제 DOM HTML" 을 가져온다.
// playwright/브라우저 미설치거나 실패하면 호출부에서 정적 HTML 로 폴백한다(여기서는 throw).

export async function renderHtml(url: string, timeoutMs = 20_000): Promise<string> {
  // lazy import: 렌더링을 안 쓰는 경우 playwright 로딩 비용/에러를 피한다.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; auto-dr/0.1; +headless)',
      viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    // DOM 로드까지 기다린 뒤, 네트워크 안정은 best-effort(분석·광고로 영원히 안 끝나는 사이트 대비).
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(500); // 지연 하이드레이션 여유
    return await page.content();
  } finally {
    await browser.close();
  }
}
