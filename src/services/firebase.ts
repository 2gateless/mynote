import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager 
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: "AIzaSyAh3LSEaukyJewUHYCd5EH4-IaDefv2Iio",
  authDomain: "mynote-53a33.firebaseapp.com",
  projectId: "mynote-53a33",
  storageBucket: "mynote-53a33.firebasestorage.app",
  messagingSenderId: "380405953405",
  appId: "1:380405953405:web:fd8b0f47c043ba2b9d5214"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
});
export const storage = getStorage(app);
// 기본 재시도 제한 시간(2분)으로 인해 업로드 실패 시 UI가 멈추는 현상을 막기 위해 15초로 단축
storage.maxUploadRetryTime = 15000;
storage.maxOperationRetryTime = 15000;

