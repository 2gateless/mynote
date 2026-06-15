import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
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
export const db = getFirestore(app);
export const storage = getStorage(app);
