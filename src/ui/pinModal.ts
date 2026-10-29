// ── 4자리 숫자 Lock 암호 설정(최초 1회 입력 + 1회 확인) 및 잠금 메모 열람 인증 모달 모듈
import { appState } from '../state';
import { saveUserLockPin } from '../services/database';
import { showToast } from '../utils/toast';

const LOCK_PIN_STORAGE_KEY = 'mynote_lock_pin';

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

export function getStoredLockPin(): string | null {
  if (typeof appState.lockPin === 'string' && /^\d{4}$/.test(appState.lockPin)) {
    return appState.lockPin;
  }
  try {
    const saved = localStorage.getItem(LOCK_PIN_STORAGE_KEY);
    if (saved && /^\d{4}$/.test(saved)) {
      appState.lockPin = saved;
      return saved;
    }
  } catch (e) {}
  return null;
}

export function setStoredLockPin(pin: string, syncToRemote = true) {
  if (!/^\d{4}$/.test(pin)) return;
  appState.lockPin = pin;
  try {
    localStorage.setItem(LOCK_PIN_STORAGE_KEY, pin);
  } catch (e) {}
  if (syncToRemote && appState.currentUser) {
    saveUserLockPin(pin).catch(err => console.warn('Lock 암호 서버 저장 실패:', err));
  }
}

export function clearStoredLockPin() {
  appState.lockPin = null;
  hasTriggeredInitialSetup = false;
  try {
    localStorage.removeItem(LOCK_PIN_STORAGE_KEY);
  } catch (e) {}
}

// Firestore user_meta 구독 결과와 로컬 Lock 암호를 동기화하고, 암호가 없으면 앱 초기 설정 모달을 띄움
export function handleUserMetaPinSync(remotePin: string | null, fromCache: boolean) {
  if (remotePin && /^\d{4}$/.test(remotePin)) {
    setStoredLockPin(remotePin, false);
    // 만약 초기 설정 모달이 떠 있는 상태에서 아직 입력 전이라면 자동으로 닫음
    if (isOpen && currentMode === 'setup' && !allowCancel && currentInput.length === 0 && setupStep === 1) {
      finishModal(true);
    }
    return;
  }

  const localPin = getStoredLockPin();
  if (localPin) {
    // 로컬에는 있으나 서버 메타에 아직 없는 경우 서버로 보정 저장
    if (!fromCache && appState.currentUser) {
      saveUserLockPin(localPin).catch(err => console.warn('Lock 암호 동기화 실패:', err));
    }
    return;
  }

  // 서버 스냅샷에서도 암호가 없는 것이 확인되면 앱 실행 초기 1회 암호 설정 모달 표시
  if (!fromCache && !hasTriggeredInitialSetup) {
    hasTriggeredInitialSetup = true;
    openPinModal('setup', false);
  }
}

// 로그인 직후 메타데이터 응답 지연/미존재 상황에서도 초기 암호 미설정 시 설정창이 뜨도록 보장
export function scheduleInitialPinSetupCheck() {
  if (getStoredLockPin() || hasTriggeredInitialSetup) return;
  setTimeout(() => {
    if (appState.currentUser && !getStoredLockPin() && !hasTriggeredInitialSetup) {
      hasTriggeredInitialSetup = true;
      openPinModal('setup', false);
    }
  }, 1200);
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
      if (descEl) descEl.textContent = '잠금 메모에 사용할 4자리 숫자를 입력해주세요';
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
      void dotsWrap.offsetWidth; // 리플로우 강제 후 애니메이션 재시작
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
  // 이미 열려있는 모달이 있다면 이전 요청을 취소 처리
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

// 잠긴 메모를 열기 전에 호출: 저장된 4자리 암호와 일치하는지 확인
export async function verifyLockPinForNote(): Promise<boolean> {
  const savedPin = getStoredLockPin();
  if (!savedPin) {
    // 만약 아직 암호가 설정되지 않은 상태라면 설정(입력+컨펌)을 먼저 진행
    return openPinModal('setup', true);
  }
  return openPinModal('verify', true);
}

// 뒤로가기(PWA popstate)나 취소 버튼 처리
export function closePinModalByBack() {
  if (!isOpen) return;
  if (currentMode === 'setup' && setupStep === 2) {
    // 확인 단계에서 뒤로가기를 누르면 1단계(처음 입력)로 복귀
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

  setTimeout(() => {
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
          setStoredLockPin(currentInput, true);
          showToast('4자리 잠금 암호가 저장되었어요 🔒');
          finishModal(true);
        } else {
          // 불일치 시 1단계로 초기화하여 다시 입력받음
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

    // verify 모드: 저장된 4자리 암호와 비교
    const savedPin = getStoredLockPin();
    if (savedPin && currentInput === savedPin) {
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
  // 초기 부팅 시 로컬 스토리지 캐시 복원
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

  // 물리 키보드 숫자 입력 지원 (PC 및 외부 키보드)
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
