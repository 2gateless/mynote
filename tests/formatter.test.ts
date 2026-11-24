import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/database', () => ({
  CATEGORIES: {
    memory: { name: '기억', icon: '💭' },
    ref_science: { name: '과학', icon: '🔬' },
  },
}));

import {
  escHtml,
  toMillis,
  buildVideoEmbed,
  linkify,
  scoreKoreanTitleMatch,
  highlightKoreanTitleMatch
} from '../src/utils/formatter';

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

  it('scoreKoreanTitleMatch는 한글 타이핑 중간 상태(초성·받침 전·연음 대기)에서도 끊김 없이 매칭해야 한다', () => {
    const title = '양자역학 정리 노트';
    // 타이핑 전 과정: ㅇ -> 야 -> 양 -> 양ㅈ -> 양자 -> 양장(양자역 입력 중) -> 양자여 -> 양자역 -> 양자역ㅎ -> 양자역학
    for (const step of ['ㅇ', '야', '양', '양ㅈ', '양자', '양장', '양자여', '양자역', '양자역ㅎ', '양자역하', '양자역학', 'ㅇㅈㅇㅎ']) {
      expect(scoreKoreanTitleMatch(title, step)).toBeGreaterThan(0);
    }
    expect(scoreKoreanTitleMatch(title, '전혀다른검색어')).toBe(0);

    // 겹받침 연음 중간 상태: '달가'를 치는 중 '닭'이 된 경우에도 매칭 유지
    expect(scoreKoreanTitleMatch('달가운 기억', '닭')).toBeGreaterThan(0);

    // 접두어 일치가 단순 포함보다 높은 점수를 받아야 함
    expect(scoreKoreanTitleMatch('메모 링크 가이드', '메모')).toBeGreaterThan(
      scoreKoreanTitleMatch('나의 메모장', '메모')
    );
  });

  it('highlightKoreanTitleMatch는 매칭된 구간을 안전하게 하이라이트하고 XSS를 방지해야 한다', () => {
    const hl = highlightKoreanTitleMatch('양자역학 <정리>', '양ㅈ');
    expect(hl).toContain('<mark class="search-hl">양자</mark>');
    expect(hl).toContain('&lt;정리&gt;');
  });
});
