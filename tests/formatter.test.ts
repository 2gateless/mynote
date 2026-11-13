import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/database', () => ({
  CATEGORIES: {
    memory: { name: '기억', icon: '💭' },
    ref_science: { name: '과학', icon: '🔬' },
  },
}));

import { escHtml, toMillis, buildVideoEmbed, linkify } from '../src/utils/formatter';

describe('formatter 유틸리티', () => {
  it('escHtml은 HTML 특수문자 및 따옴표를 모두 이스케이프해야 한다', () => {
    expect(escHtml(`<script>"alert('xss')" & </script>`)).toBe(
      '&lt;script&gt;&quot;alert(&#39;xss&#39;)&quot; &amp; &lt;/script&gt;'
    );
  });

  it('toMillis는 다양한 타임스탬프 형식을 밀리초로 변환해야 한다', () => {
    expect(toMillis(null)).toBe(0);
    expect(toMillis(1700000000000)).toBe(1700000000000);
    expect(toMillis(new Date(1700000000000))).toBe(1700000000000);
    expect(toMillis({ seconds: 1700 })).toBe(1700000);
    expect(toMillis({ _seconds: 1700 })).toBe(1700000);
    expect(toMillis({ toMillis: () => 123456 })).toBe(123456);
  });

  it('linkify는 URL을 안전한 새 탭 링크로 변환하고 일반 텍스트는 이스케이프해야 한다', () => {
    const res = linkify('참고: https://example.com/a?x=1&y=2 <test>');
    expect(res).toContain('<a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"');
    expect(res).toContain('&lt;test&gt;');
  });

  it('buildVideoEmbed는 YouTube URL을 embed iframe으로 변환해야 한다', () => {
    const html = buildVideoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 0);
    expect(html).toContain('https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1');
    expect(html).toContain('YouTube');
  });
});
