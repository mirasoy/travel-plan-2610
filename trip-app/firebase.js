// 기존 가족여행 페이지(vote.html)와 같은 Firebase 프로젝트(travel-26), 같은 SDK 버전(10.12.2).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyARuzrDMQb4oMYcJywrMNctXopIHeqCNUA",
  authDomain: "travel-26.firebaseapp.com",
  projectId: "travel-26",
  storageBucket: "travel-26.firebasestorage.app",
  messagingSenderId: "174199082566",
  appId: "1:174199082566:web:7d4fc7c1cf429e941d8447"
};

// 앱 이름을 따로 주어 같은 오리진의 다른 페이지 초기화와 충돌하지 않게 한다.
export const app = initializeApp(firebaseConfig, 'trip-app');
export const db = getFirestore(app);

export {
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
