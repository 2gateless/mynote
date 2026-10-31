// ── 4자리 숫자 Lock 암호 설정(최초 1회 입력 + 1회 확인) 및 잠금 메모 열람 인증 모달 모듈
// ※ 보안: 암호(PIN)는 평문으로 저장하거나 메모리에 보관하지 않으며, Web Crypto SHA-256 + 솔트로 해시화하여 이 기기(localStorage)에만 보관합니다.
import { appState } from '../state';
import { showToast } from '../utils/toast';

const LEGACY_LOCK_PIN_STORAGE_KEY = 'mynote_lock_pin';
const LOCK_PIN_HASH_KEY = 'mynote_lock_pin_hash_v1';
const LOCK_PIN_SALT_KEY = 'mynote_lock_pin_salt_v1';

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

const $ = (id: string) => document.getElementById(id);

// Web Crypto SHA-256 + 솔트 해시 계산 헬퍼
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

export async function setStoredLockPin(pin: string): Promise<void> {
  if (!/^\d{4}$/.test(pin)) return;
  try {
    const salt = getOrCreateSalt();
    const hash = await hashPin(pin, salt);
    localStorage.setItem(LOCK_PIN_HASH_KEY, hash);
    // 기존에 평문으로 남아있던 PIN 키는 즉시 안전하게 파기
    localStorage.removeItem(LEGACY_LOCK_PIN_STORAGE_KEY);
  } catch (e) {
    console.error('PIN 암호화 저장 실패:', e);
  }
}

// 이 기기(브라우저/앱)에 저장된 Lock 암호가 없으면 앱 실행 초기에 1회 설정 모달을 표시
export function scheduleInitialPinSetupCheck() {
  if (hasStoredLockPin() || hasTriggeredInitialSetup) return;
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
  const modal = $('pin-modal');
  if (modal) modal.style.display = 'none';
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

  updateModalTexts();
  renderDots();
  setErrorMsg('');

  const modal = $('pin-modal');
  if (modal) modal.style.display = 'flex';

  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
  });
}

// 잠긴 메모를 열기 전에 호출: 기기에 저장된 4자리 암호와 일치하는지 확인
export async function verifyLockPinForNote(): Promise<boolean> {
  const savedPin = getStoredLockPin();
  if (!savedPin) {
    return openPinModal('setup', true);
  }
  return openPinModal('verify', true);
}

// 뒤로가기(PWA popstate)나 취소 버튼 처리
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
      finishModal(true);
    } else {
      currentInput = '';
      isProcessingStep = false;
      renderDots();
      setErrorMsg('암호가 일치하지 않아요', true);
    }
  }, 130);
}

function appendDigit(digit: string) {
  if (!isOpen || isProcessingStep || currentInput.length >= 4) return;
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
  setErrorMsg('');
  currentInput = currentInput.slice(0, -1);
  renderDots();
}

function resetDigits() {
  if (!isOpen || isProcessingStep) return;
  setErrorMsg('');
  currentInput = '';
  renderDots();
}

export function initPinModal() {
  getStoredLockPin();

  const keypad = $('pin-keypad');
  if (keypad) {
    keypad.addEventListener('click', (e) => {
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
