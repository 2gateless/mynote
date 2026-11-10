// ── 4자리 숫자 Lock 암호 설정(최초 1회 입력 + 1회 확인) 및 잠금 메모 열람 인증 모달 모듈
// ※ 보안: 암호(PIN)는 평문으로 저장하거나 메모리에 보관하지 않으며, Web Crypto SHA-256 + 솔트로 해시화하여 이 기기(localStorage)에만 보관합니다.
// ※ Brute-force 방어: 5회 이상 연속 오류 시 24시간 동안 입력이 차단되며 2gateless@gmail.com으로 보안 경고 메일이 발송됩니다.
import { doc, getDoc, setDoc, collection, addDoc, Timestamp } from 'firebase/firestore';
import { db } from '../services/firebase';
import { appState } from '../state';
import { showToast } from '../utils/toast';

const LEGACY_LOCK_PIN_STORAGE_KEY = 'mynote_lock_pin';
const LOCK_PIN_HASH_KEY = 'mynote_lock_pin_hash_v1';
const LOCK_PIN_SALT_KEY = 'mynote_lock_pin_salt_v1';
const LOCK_PIN_FAIL_COUNT_KEY = 'mynote_lock_pin_fail_count';
const LOCK_PIN_LOCKOUT_UNTIL_KEY = 'mynote_lock_pin_lockout_until';

const MAX_FAIL_COUNT = 5;
const LOCKOUT_DURATION_MS = 24 * 60 * 60 * 1000; // 24시간 잠금
const ALERT_EMAIL = '2gateless@gmail.com';

type PinModalMode = 'setup' | 'verify';

let isOpen = false;
let currentMode: PinModalMode = 'verify';
let allowCancel = true;
let setupStep: 1 | 2 = 1;
let firstPin = '';
let currentInput = '';
let isProcessingStep = false;
let pendingResolve: ((ok: boolean) => void) | null = null;
let hasTriggeredInitialSetup = false;
let lockoutTimerInterval: any = null;
let pinMetaSyncedUid: string | null = null;
let pinMetaSyncPromise: Promise<void> | null = null;

const $ = (id: string) => document.getElementById(id);

// ─────────────────────────────────────────────
// 잠금 및 대기시간 연장(24시간) 관리 헬퍼
// ─────────────────────────────────────────────

function getLockoutRemainingMs(): number {
  try {
    const until = Number(localStorage.getItem(LOCK_PIN_LOCKOUT_UNTIL_KEY) || 0);
    const now = Date.now();
    if (until > now) {
      return until - now;
    }
    // 24시간이 경과한 경우 잠금 및 오류 횟수 초기화
    if (until > 0) {
      localStorage.removeItem(LOCK_PIN_LOCKOUT_UNTIL_KEY);
      localStorage.removeItem(LOCK_PIN_FAIL_COUNT_KEY);
    }
  } catch {}
  return 0;
}

export function isCurrentlyLockedOut(): boolean {
  return getLockoutRemainingMs() > 0;
}

function formatRemainingTime(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) {
    return `${hours}시간 ${minutes}분 ${seconds}초`;
  }
  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }
  return `${seconds}초`;
}

// 5회 실패 시 2gateless@gmail.com으로 긴급 보안 경고 이메일 발송 및 Firestore 기록
async function sendLockoutEmailNotification(attempts: number, lockedUntilMs: number) {
  const lockedDate = new Date(lockedUntilMs).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const nowStr = new Date().toLocaleString('ko-KR');

  const subject = `🚨 [MyNote 보안 경고] 4자리 암호 ${attempts}회 연속 오류로 인한 24시간 입력 잠금`;
  const messageBody = `
[MyNote 보안 경고]
귀하의 MyNote 계정에서 잠긴 메모의 4자리 암호(PIN)가 ${attempts}회 연속으로 잘못 입력되었습니다.

무차별 대입 공격(Brute-force)을 방지하기 위해 해당 기기에서의 메모 암호 입력이 24시간 동안 완전히 차단되었습니다.

- 잠금 발생 시각: ${nowStr}
- 잠금 해제 예정 시각: ${lockedDate}
- 사용자 이메일: ${ALERT_EMAIL}
- 접속 기기 및 환경: ${navigator.userAgent}

본인이 시도한 것이 아니라면 다른 사람이 회원님의 메모 열람을 시도했을 가능성이 있으니 계정 보안 상태를 점검하시기 바랍니다.
`.trim();

  // 1) formsubmit.co AJAX 엔드포인트를 통해 2gateless@gmail.com으로 백그라운드 발송
  try {
    fetch(`https://formsubmit.co/ajax/${ALERT_EMAIL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        _subject: subject,
        email: ALERT_EMAIL,
        message: messageBody,
        timestamp: nowStr,
        unlockTime: lockedDate,
        userAgent: navigator.userAgent
      })
    }).catch(err => console.warn('이메일 통지 발송 API 오류:', err));
  } catch (e) {
    console.warn('이메일 통지 발송 실패:', e);
  }

  // 2) Firestore에 보안 경고 로그(security_alerts 컬렉션 및 user_meta) 영구 보존
  try {
    const user = appState.currentUser;
    if (user) {
      // 정적 임포트된 Firestore 모듈 사용 (불필요한 동적 import 경고 제거)


      await setDoc(doc(db, 'user_meta', user.uid), {
        pinLockoutUntil: Timestamp.fromMillis(lockedUntilMs),
        pinFailCount: attempts,
        lastSecurityAlertAt: Timestamp.now()
      }, { merge: true });

      await addDoc(collection(db, 'security_alerts'), {
        uid: user.uid,
        email: ALERT_EMAIL,
        type: 'PIN_LOCKOUT_24H',
        attempts,
        lockedUntil: Timestamp.fromMillis(lockedUntilMs),
        createdAt: Timestamp.now(),
        userAgent: navigator.userAgent
      });
    }
  } catch (e) {
    console.warn('Firestore 보안 경고 기록 오류:', e);
  }
}

// ─────────────────────────────────────────────
// Web Crypto SHA-256 + 솔트 해시 계산 헬퍼
// ─────────────────────────────────────────────
async function hashPin(pin: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}:${pin}:mynote_secure_lock`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getOrCreateSalt(): string {
  try {
    let salt = localStorage.getItem(LOCK_PIN_SALT_KEY);
    if (!salt) {
      const arr = new Uint8Array(16);
      crypto.getRandomValues(arr);
      salt = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(LOCK_PIN_SALT_KEY, salt);
    }
    return salt;
  } catch {
    return 'mynote_fallback_salt_seed';
  }
}

/** 이 기기에 PIN 암호가 설정되어 있는지 여부 확인 */
export function hasStoredLockPin(): boolean {
  try {
    if (localStorage.getItem(LOCK_PIN_HASH_KEY)) return true;
    const legacy = localStorage.getItem(LEGACY_LOCK_PIN_STORAGE_KEY);
    if (legacy && /^\d{4}$/.test(legacy)) return true;
  } catch {}
  return false;
}

/**
 * 기존 호출부와의 호환을 위한 헬퍼.
 * 보안을 위해 실제 4자리 평문 암호 대신 설정 여부(불리언 판별 가능한 마스킹 문자열 또는 null)만 반환합니다.
 */
export function getStoredLockPin(): string | null {
  return hasStoredLockPin() ? '****' : null;
}

export function clearPinMetaSyncState() {
  pinMetaSyncedUid = null;
  pinMetaSyncPromise = null;
  hasTriggeredInitialSetup = false;
}

/**
 * Firestore user_meta/{uid}와 PIN 해시·24시간 잠금 상태를 양방향 동기화.
 * 브라우저 사이트 데이터(localStorage) 삭제 후에도 기존 PIN 설정과 잠금 차단이 우회되지 않도록 보호합니다.
 */
export async function syncPinFromUserMeta(force = false): Promise<void> {
  const user = appState.currentUser;
  if (!user) return;
  if (!force && pinMetaSyncedUid === user.uid) return;
  if (!force && pinMetaSyncPromise) return pinMetaSyncPromise;

  pinMetaSyncPromise = (async () => {
    try {
      const metaRef = doc(db, 'user_meta', user.uid);
      const snap = await getDoc(metaRef);
      const data = snap.exists() ? snap.data() : {};

      // 1) PIN 해시 & 솔트 동기화
      if (typeof data.pinHash === 'string' && data.pinHash && typeof data.pinSalt === 'string' && data.pinSalt) {
        try {
          localStorage.setItem(LOCK_PIN_HASH_KEY, data.pinHash);
          localStorage.setItem(LOCK_PIN_SALT_KEY, data.pinSalt);
          localStorage.removeItem(LEGACY_LOCK_PIN_STORAGE_KEY);
        } catch {}
      } else {
        // 클라우드에 아직 없고 로컬에만 해시가 있다면 클라우드에 백업
        try {
          const localHash = localStorage.getItem(LOCK_PIN_HASH_KEY);
          const localSalt = localStorage.getItem(LOCK_PIN_SALT_KEY);
          if (localHash && localSalt) {
            await setDoc(metaRef, { pinHash: localHash, pinSalt: localSalt }, { merge: true });
          }
        } catch {}
      }

      // 2) 24시간 잠금 만료 시각 & 실패 횟수 복원
      const remoteUntil = data.pinLockoutUntil
        ? (typeof data.pinLockoutUntil.toMillis === 'function' ? data.pinLockoutUntil.toMillis() : Number(data.pinLockoutUntil) || 0)
        : 0;
      const localUntil = Number(localStorage.getItem(LOCK_PIN_LOCKOUT_UNTIL_KEY) || 0);
      if (remoteUntil > Date.now() && remoteUntil > localUntil) {
        try {
          localStorage.setItem(LOCK_PIN_LOCKOUT_UNTIL_KEY, String(remoteUntil));
        } catch {}
      }

      const remoteFails = Number(data.pinFailCount || 0);
      const localFails = Number(localStorage.getItem(LOCK_PIN_FAIL_COUNT_KEY) || 0);
      if (remoteFails > localFails && (remoteUntil > Date.now() || localUntil === 0)) {
        try {
          localStorage.setItem(LOCK_PIN_FAIL_COUNT_KEY, String(remoteFails));
        } catch {}
      }

      pinMetaSyncedUid = user.uid;
    } catch (e) {
      console.warn('Firestore PIN 상태 동기화 실패:', e);
    } finally {
      pinMetaSyncPromise = null;
    }
  })();

  return pinMetaSyncPromise;
}

export async function setStoredLockPin(pin: string): Promise<void> {
  if (!/^\d{4}$/.test(pin)) return;
  try {
    const salt = getOrCreateSalt();
    const hash = await hashPin(pin, salt);
    localStorage.setItem(LOCK_PIN_HASH_KEY, hash);
    // 기존에 평문으로 남아있던 PIN 키는 즉시 안전하게 파기
    localStorage.removeItem(LEGACY_LOCK_PIN_STORAGE_KEY);
    if (appState.currentUser) {
      setDoc(
        doc(db, 'user_meta', appState.currentUser.uid),
        { pinHash: hash, pinSalt: salt },
        { merge: true }
      ).catch(err => console.warn('클라우드 PIN 해시 백업 오류:', err));
    }
  } catch (e) {
    console.error('PIN 암호화 저장 실패:', e);
  }
}

// 이 기기(브라우저/앱)에 저장된 Lock 암호가 없으면 앱 실행 초기에 1회 설정 모달을 표시
export async function scheduleInitialPinSetupCheck() {
  if (hasStoredLockPin() || hasTriggeredInitialSetup) return;
  if (appState.currentUser) {
    await syncPinFromUserMeta();
  }
  if (hasStoredLockPin() || hasTriggeredInitialSetup) return;
  // 아직 인증 전 상태(낙관적 캐시 부팅)라면 인증 완료 후 클라우드 해시를 먼저 확인한 뒤 결정
  if (!appState.currentUser) return;
  hasTriggeredInitialSetup = true;
  openPinModal('setup', false);
}

function updateModalTexts() {
  const iconEl = $('pin-modal-icon');
  const titleEl = $('pin-modal-title');
  const descEl = $('pin-modal-desc');
  const cancelBtn = $('pin-btn-cancel');
  const actionsWrap = $('pin-modal-actions');

  if (currentMode === 'setup') {
    if (setupStep === 1) {
      if (iconEl) iconEl.textContent = '🔐';
      if (titleEl) titleEl.textContent = 'Lock 암호 초기 설정';
      if (descEl) descEl.textContent = '이 기기에서 잠금 메모에 사용할 4자리 숫자를 입력해주세요';
      if (actionsWrap && cancelBtn) {
        if (allowCancel) {
          actionsWrap.style.display = 'block';
          cancelBtn.textContent = '취소';
        } else {
          actionsWrap.style.display = 'none';
        }
      }
    } else {
      if (iconEl) iconEl.textContent = '✅';
      if (titleEl) titleEl.textContent = 'Lock 암호 확인';
      if (descEl) descEl.textContent = '확인을 위해 동일한 4자리 숫자를 한 번 더 입력해주세요';
      if (actionsWrap && cancelBtn) {
        actionsWrap.style.display = 'block';
        cancelBtn.textContent = '← 다시 입력';
      }
    }
  } else {
    if (iconEl) iconEl.textContent = '🔒';
    if (titleEl) titleEl.textContent = '잠긴 메모';
    if (descEl) descEl.textContent = '메모를 열려면 4자리 암호를 입력해주세요';
    if (actionsWrap && cancelBtn) {
      actionsWrap.style.display = 'block';
      cancelBtn.textContent = '취소';
    }
  }
}

function updateLockoutUI() {
  const remMs = getLockoutRemainingMs();
  const keypad = $('pin-keypad');
  const dotsWrap = $('pin-dots');
  const iconEl = $('pin-modal-icon');
  const titleEl = $('pin-modal-title');
  const descEl = $('pin-modal-desc');

  if (remMs > 0) {
    if (keypad) keypad.classList.add('locked-out');
    if (dotsWrap) dotsWrap.style.display = 'none';
    if (iconEl) iconEl.textContent = '🚫';
    if (titleEl) titleEl.textContent = '암호 입력 24시간 차단됨';
    if (descEl) {
      descEl.innerHTML = `암호 5회 연속 오류로 24시간 동안 잠겼습니다.<br><b style="color:var(--danger)">${ALERT_EMAIL}</b>으로 보안 경고가 통지되었습니다.`;
    }
    setErrorMsg(`⏳ 남은 잠금 시간: ${formatRemainingTime(remMs)}`, false);
  } else {
    if (keypad) keypad.classList.remove('locked-out');
    if (dotsWrap) dotsWrap.style.display = 'flex';
    if (lockoutTimerInterval) {
      clearInterval(lockoutTimerInterval);
      lockoutTimerInterval = null;
    }
    updateModalTexts();
    setErrorMsg('');
  }
}

function startLockoutTimer() {
  if (lockoutTimerInterval) clearInterval(lockoutTimerInterval);
  updateLockoutUI();
  lockoutTimerInterval = setInterval(() => {
    const rem = getLockoutRemainingMs();
    if (rem <= 0) {
      clearInterval(lockoutTimerInterval);
      lockoutTimerInterval = null;
      updateLockoutUI();
      showToast('24시간 잠금이 해제되었습니다. 암호를 다시 입력해주세요.');
    } else {
      updateLockoutUI();
    }
  }, 1000);
}

function renderDots() {
  const dotsWrap = $('pin-dots');
  if (!dotsWrap) return;
  const dots = dotsWrap.querySelectorAll('.pin-dot');
  dots.forEach((dot, idx) => {
    dot.classList.toggle('filled', idx < currentInput.length);
  });
}

function setErrorMsg(msg: string, shake = false) {
  const errEl = $('pin-error-msg');
  if (errEl) errEl.textContent = msg;
  if (shake) {
    const dotsWrap = $('pin-dots');
    if (dotsWrap) {
      dotsWrap.classList.remove('shake');
      void dotsWrap.offsetWidth;
      dotsWrap.classList.add('shake');
    }
  }
}

function finishModal(result: boolean) {
  if (lockoutTimerInterval) {
    clearInterval(lockoutTimerInterval);
    lockoutTimerInterval = null;
  }
  const modal = $('pin-modal');
  if (modal) modal.style.display = 'none';
  const keypad = $('pin-keypad');
  if (keypad) keypad.classList.remove('locked-out');
  const dotsWrap = $('pin-dots');
  if (dotsWrap) dotsWrap.style.display = 'flex';

  isOpen = false;
  isProcessingStep = false;
  currentInput = '';
  firstPin = '';
  setupStep = 1;
  renderDots();
  setErrorMsg('');
  if (pendingResolve) {
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(result);
  }
}

export function openPinModal(mode: PinModalMode, canCancel = true): Promise<boolean> {
  if (pendingResolve) {
    const prev = pendingResolve;
    pendingResolve = null;
    prev(false);
  }

  currentMode = mode;
  allowCancel = canCancel;
  setupStep = 1;
  firstPin = '';
  currentInput = '';
  isProcessingStep = false;
  isOpen = true;

  const modal = $('pin-modal');
  if (modal) modal.style.display = 'flex';

  if (mode === 'verify' && isCurrentlyLockedOut()) {
    startLockoutTimer();
  } else {
    updateModalTexts();
    renderDots();
    setErrorMsg('');
  }

  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
  });
}

// 잠긴 메모를 열기 전에 호출: 클라우드와 기기 내 4자리 암호 및 잠금 상태를 동기화한 뒤 검증
export async function verifyLockPinForNote(): Promise<boolean> {
  if (appState.currentUser) {
    await syncPinFromUserMeta();
  }
  const savedPin = getStoredLockPin();
  if (!savedPin) {
    return openPinModal('setup', true);
  }
  return openPinModal('verify', true);
}

// 뒤로가기(PWA popstate)나 취소 버튼 처리
// 뒤로가기(PWA popstate)나 취소 버튼 처리
export function closePinModalSilently() {
  if (isOpen) finishModal(false);
}
export function closePinModalByBack() {
  if (!isOpen) return;
  if (currentMode === 'setup' && setupStep === 2) {
    setupStep = 1;
    firstPin = '';
    currentInput = '';
    isProcessingStep = false;
    setErrorMsg('');
    updateModalTexts();
    renderDots();
    return;
  }
  if (allowCancel) {
    finishModal(false);
  }
}

function handleFourDigitsEntered() {
  if (currentInput.length !== 4 || isProcessingStep) return;
  if (currentMode === 'verify' && isCurrentlyLockedOut()) return;

  isProcessingStep = true;

  setTimeout(async () => {
    if (!isOpen) return;

    if (currentMode === 'setup') {
      if (setupStep === 1) {
        firstPin = currentInput;
        currentInput = '';
        setupStep = 2;
        isProcessingStep = false;
        setErrorMsg('');
        updateModalTexts();
        renderDots();
      } else {
        if (currentInput === firstPin) {
          await setStoredLockPin(currentInput);
          localStorage.removeItem(LOCK_PIN_FAIL_COUNT_KEY);
          localStorage.removeItem(LOCK_PIN_LOCKOUT_UNTIL_KEY);
          showToast('이 기기에 4자리 잠금 암호가 암호화되어 저장되었어요 🔒');
          finishModal(true);
        } else {
          setupStep = 1;
          firstPin = '';
          currentInput = '';
          isProcessingStep = false;
          updateModalTexts();
          renderDots();
          setErrorMsg('암호가 일치하지 않아요. 처음부터 다시 입력해주세요', true);
        }
      }
      return;
    }

    // verify 모드: 해시 검증 (레거시 평문 저장된 기기는 1회 검증 후 자동 해시 마이그레이션)
    const pinToVerify = currentInput;
    let isValid = false;
    try {
      const storedHash = localStorage.getItem(LOCK_PIN_HASH_KEY);
      if (storedHash) {
        const salt = getOrCreateSalt();
        const computed = await hashPin(pinToVerify, salt);
        isValid = computed === storedHash;
      } else {
        const legacyPin = localStorage.getItem(LEGACY_LOCK_PIN_STORAGE_KEY);
        if (legacyPin && legacyPin === pinToVerify) {
          isValid = true;
          // 평문 암호를 즉시 SHA-256 해시로 업그레이드하고 평문 키 삭제
          await setStoredLockPin(pinToVerify);
        }
      }
    } catch (e) {
      console.error('PIN 검증 중 오류:', e);
    }

    if (isValid) {
      // 검증 성공 시 실패 카운트 및 잠금 해제 (로컬 + 클라우드 동시 초기화)
      localStorage.removeItem(LOCK_PIN_FAIL_COUNT_KEY);
      localStorage.removeItem(LOCK_PIN_LOCKOUT_UNTIL_KEY);
      if (appState.currentUser) {
        setDoc(
          doc(db, 'user_meta', appState.currentUser.uid),
          { pinFailCount: 0, pinLockoutUntil: null },
          { merge: true }
        ).catch(() => {});
      }
      finishModal(true);
    } else {
      currentInput = '';
      isProcessingStep = false;
      renderDots();

      let failCount = Number(localStorage.getItem(LOCK_PIN_FAIL_COUNT_KEY) || 0) + 1;
      localStorage.setItem(LOCK_PIN_FAIL_COUNT_KEY, String(failCount));

      if (failCount >= MAX_FAIL_COUNT) {
        const lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
        localStorage.setItem(LOCK_PIN_LOCKOUT_UNTIL_KEY, String(lockoutUntil));
        // 이메일 통지 발송 & Firestore 보안 기록
        sendLockoutEmailNotification(failCount, lockoutUntil);
        showToast(`⚠️ 암호 5회 연속 오류로 24시간 동안 잠겼습니다. 관리자 메일(${ALERT_EMAIL})로 통지되었습니다.`);
        startLockoutTimer();
      } else {
        if (appState.currentUser) {
          setDoc(
            doc(db, 'user_meta', appState.currentUser.uid),
            { pinFailCount: failCount },
            { merge: true }
          ).catch(() => {});
        }
        const remain = MAX_FAIL_COUNT - failCount;
        setErrorMsg(`암호가 일치하지 않아요 (${failCount}/${MAX_FAIL_COUNT}회 오류 · ${remain}회 후 24시간 잠금)`, true);
      }
    }
  }, 130);
}

function appendDigit(digit: string) {
  if (!isOpen || isProcessingStep || currentInput.length >= 4) return;
  if (currentMode === 'verify' && isCurrentlyLockedOut()) return;
  if (!/^\d$/.test(digit)) return;
  setErrorMsg('');
  currentInput += digit;
  renderDots();
  if (currentInput.length === 4) {
    handleFourDigitsEntered();
  }
}

function deleteLastDigit() {
  if (!isOpen || isProcessingStep || currentInput.length === 0) return;
  if (currentMode === 'verify' && isCurrentlyLockedOut()) return;
  setErrorMsg('');
  currentInput = currentInput.slice(0, -1);
  renderDots();
}

function resetDigits() {
  if (!isOpen || isProcessingStep) return;
  if (currentMode === 'verify' && isCurrentlyLockedOut()) return;
  setErrorMsg('');
  currentInput = '';
  renderDots();
}

export function initPinModal() {
  getStoredLockPin();

  const keypad = $('pin-keypad');
  if (keypad) {
    keypad.addEventListener('click', (e) => {
      if (currentMode === 'verify' && isCurrentlyLockedOut()) return;
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;
      const digit = btn.dataset.digit;
      if (digit !== undefined) {
        appendDigit(digit);
      } else if (btn.id === 'pin-key-back') {
        deleteLastDigit();
      } else if (btn.id === 'pin-key-reset') {
        resetDigits();
      }
    });
  }

  const cancelBtn = $('pin-btn-cancel');
  if (cancelBtn) {
    cancelBtn.onclick = () => closePinModalByBack();
  }

  const modal = $('pin-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'pin-modal' && allowCancel) {
        finishModal(false);
      }
    });
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!isOpen) return;
    if (currentMode === 'verify' && isCurrentlyLockedOut()) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePinModalByBack();
      }
      return;
    }
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      appendDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      deleteLastDigit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePinModalByBack();
    }
  });
}
