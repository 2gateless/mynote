export function getShareText(currentNote: any) {
  if (!currentNote) return { title: '', body: '' };
  return {
    title: currentNote.title || '제목 없음',
    body: currentNote.body || ''
  };
}

export function shareViaEmail(title: string, body: string) {
  location.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export function shareViaKakao(title: string, body: string, onShowToast: (msg: string) => void) {
  const text = `${title}\n\n${body}`;
  const isAndroid = /android/i.test(navigator.userAgent);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  if (isAndroid) {
    const intentUrl = `intent://send#Intent;action=android.intent.action.SEND;type=text/plain;S.android.intent.extra.TEXT=${encodeURIComponent(text)};package=com.kakao.talk;end`;
    const timer = setTimeout(() => {
      onShowToast('카카오톡이 설치되어 있지 않아요');
    }, 1500);
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
    window.addEventListener('blur', () => clearTimeout(timer), { once: true });
    location.href = intentUrl;
  } else if (isIOS) {
    const kakaoUrl = `kakaolink://send?text=${encodeURIComponent(text)}`;
    const timer = setTimeout(() => {
      onShowToast('카카오톡이 설치되어 있지 않아요');
    }, 1500);
    window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
    window.addEventListener('blur', () => clearTimeout(timer), { once: true });
    location.href = kakaoUrl;
  } else {
    onShowToast('카카오톡 공유는 모바일에서 지원됩니다.');
  }
}

export function shareViaTelegram(title: string, body: string) {
  const text = `${title}\n\n${body}`;
  window.open(`https://t.me/share/url?url=${encodeURIComponent(window.location.href)}&text=${encodeURIComponent(text)}`, '_blank');
}

export function shareViaNative(title: string, body: string, onShowToast: (msg: string) => void) {
  if (navigator.share) {
    navigator.share({ title, text: body }).catch(console.error);
  } else {
    onShowToast('이 브라우저에서는 공유 기능을 지원하지 않아요');
  }
}
