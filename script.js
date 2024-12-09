if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/service-worker.js")
    .then(function (registration) {
      console.log("Service Worker registered with scope:", registration.scope);
    })
    .catch(function (error) {
      console.log("Service Worker registration failed:", error);
    });
}

const keyScreen = document.getElementById("keyScreen");
const mainScreen = document.getElementById("mainScreen");
const answerScreen = document.getElementById("answerScreen");

const displayEl = document.getElementById("display");
const recordBtn = document.getElementById("recordBtn");
const cancelBtn = document.getElementById("cancelBtn");

const qaDisplay = document.getElementById("qaDisplay");
const askAgainBtn = document.getElementById("askAgainBtn");
const moreBtn = document.getElementById("moreBtn");
const recommendedQuestionsContainer = document.getElementById(
  "recommendedQuestions"
);

const apiKeyInput = document.getElementById("apiKeyInput");
const saveKeyBtn = document.getElementById("saveKeyBtn");

let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let recordingCanceled = false;
let lastQuestion = "";

// We maintain full conversation context:
let messages = [
  {
    role: "system",
    content:
      "Kullanıcının sorduğu dilde, soruya kısa, öz ve yorumsuz bir cevap ver. Cevabının sonunda 'NEXT_QUESTIONS:' başlığı altında 3 uygun sonraki soru önerisi ver.\nFormat:\nNEXT_QUESTIONS:\n1) …\n2) …\n3) …",
  },
];

let encryptionKey = null;
let encryptedApiKey = null;
let apiKey = null;

const DB_NAME = "assistant_db";
const DB_STORE = "data";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function getData(key) {
  return openDb().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);
      const req = store.get(key);
      req.onsuccess = () => {
        resolve(req.result ? req.result.value : null);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  });
}

function setData(key, value) {
  return openDb().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  });
}

async function init() {
  const encryptionKeyJwk = await getData("encryptionKeyJwk");
  const encApiKey = await getData("encryptedApiKey");

  if (encryptionKeyJwk && encApiKey) {
    encryptionKey = await crypto.subtle.importKey(
      "jwk",
      encryptionKeyJwk,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    encryptedApiKey = encApiKey;

    apiKey = await decryptApiKey(encryptedApiKey, encryptionKey);
    showMainScreen();
  } else {
    keyScreen.style.display = "block";
  }
}

saveKeyBtn.addEventListener("click", async () => {
  const enteredKey = apiKeyInput.value.trim();
  if (!enteredKey) return;

  encryptionKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  encryptedApiKey = await encryptApiKey(enteredKey, encryptionKey);

  const jwk = await crypto.subtle.exportKey("jwk", encryptionKey);
  await setData("encryptionKeyJwk", jwk);
  await setData("encryptedApiKey", encryptedApiKey);

  apiKey = enteredKey;
  keyScreen.style.display = "none";
  showMainScreen();
});

function showMainScreen() {
  mainScreen.style.display = "flex";
}

function showAnswerScreen(question, answer, nextQuestions) {
  mainScreen.style.display = "none";
  answerScreen.style.display = "flex";

  qaDisplay.innerHTML = `
      <p style="margin-top:0;">${answer}</p>
  `;

  // Clear previous recommended questions
  recommendedQuestionsContainer.innerHTML = "";

  if (nextQuestions && nextQuestions.length === 3) {
    nextQuestions.forEach((q) => {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = q;
      btn.addEventListener("click", () => {
        askRecommendedQuestion(q);
      });
      recommendedQuestionsContainer.appendChild(btn);
    });
  }
}

// Encrypt/Decrypt Functions
async function encryptApiKey(plainKey, cryptoKey) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plainKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    data
  );

  const combined = new Uint8Array(iv.length + new Uint8Array(encrypted).length);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return combined;
}

async function decryptApiKey(encryptedData, cryptoKey) {
  const iv = encryptedData.slice(0, 12);
  const ciphertext = encryptedData.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    ciphertext
  );
  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}

async function initRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream);

  mediaRecorder.ondataavailable = (event) => {
    audioChunks.push(event.data);
  };

  mediaRecorder.onstop = async () => {
    if (recordingCanceled) {
      resetToInitialState();
      return;
    }

    displayEl.textContent = "Yazıya dönüştürülüyor...";
    const audioBlob = new Blob(audioChunks, { type: "audio/mp4" });
    audioChunks = [];

    try {
      const transcription = await transcribeAudio(audioBlob);
      if (transcription && transcription.trim() !== "") {
        lastQuestion = transcription.trim();
        displayEl.textContent = `Sorduğunuz: "${lastQuestion}"\nDüşünüyor...`;

        messages.push({ role: "user", content: lastQuestion });

        const { answer, nextQuestions } = await getFullResponse(messages);
        messages.push({ role: "assistant", content: answer });

        showAnswerScreen(lastQuestion, answer, nextQuestions);
      } else {
        displayEl.textContent = "Metin elde edilemedi.";
      }
    } catch (err) {
      console.error(err);
      displayEl.textContent = "İstek işlenirken hata oluştu.";
    }
  };
}

recordBtn.addEventListener("click", async () => {
  if (!mediaRecorder && apiKey) {
    await initRecording();
  }

  if (!isRecording && mediaRecorder && apiKey) {
    audioChunks = [];
    recordingCanceled = false;
    mediaRecorder.start();
    displayEl.textContent =
      "Kaydediliyor... Durdurmak için tekrar dokunun veya 'İptal'e basın.";
    recordBtn.textContent = "🛑 Durdur";
    cancelBtn.style.display = "inline-block";
    isRecording = true;
  } else if (isRecording) {
    mediaRecorder.stop();
    recordBtn.textContent = "🎤 Başla";
    cancelBtn.style.display = "none";
    isRecording = false;
  }
});

cancelBtn.addEventListener("click", () => {
  if (isRecording && mediaRecorder.state === "recording") {
    recordingCanceled = true;
    mediaRecorder.stop();
  }
});

function resetToInitialState() {
  displayEl.textContent = "Mikrofona dokunun, konuşun, tekrar dokunun.";
  recordBtn.textContent = "🎤 Başla";
  cancelBtn.style.display = "none";
  isRecording = false;
  recordingCanceled = false;
}

// Transcription
async function transcribeAudio(audioBlob) {
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.mp4");
  formData.append("model", "whisper-1");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI Hatası:", errorText);
    throw new Error("Transkripsiyon alınamadı.");
  }

  const result = await response.json();
  return result.text;
}

async function getFullResponse(fullMessages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "gpt-4-turbo",
      messages: fullMessages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("OpenAI Chat Hatası:", errorText);
    throw new Error("Cevap alınamadı.");
  }

  const data = await response.json();
  let fullText =
    data.choices && data.choices.length > 0
      ? data.choices[0].message.content.trim()
      : "Cevap yok.";

  // Parse out NEXT_QUESTIONS
  const splitIndex = fullText.indexOf("NEXT_QUESTIONS:");
  let answerText = fullText;
  let nextQs = [];

  if (splitIndex !== -1) {
    answerText = fullText.slice(0, splitIndex).trim();
    const remainder = fullText.slice(splitIndex);
    const lines = remainder
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l);
    // lines look like ["NEXT_QUESTIONS:", "1) q1", "2) q2", "3) q3"]
    const questions = lines.slice(1).map((l) => l.replace(/^\d+\)\s*/, ""));
    nextQs = questions;
  }

  return { answer: answerText, nextQuestions: nextQs };
}

askAgainBtn.addEventListener("click", () => {
  answerScreen.style.display = "none";
  mainScreen.style.display = "flex";
  resetToInitialState();
});

moreBtn.addEventListener("click", async () => {
  qaDisplay.innerHTML += "\n\n<p>[Daha cevap isteniyor...]</p>";
  const { answer, nextQuestions } = await getFullResponse(messages);
  messages.push({ role: "assistant", content: answer });

  qaDisplay.innerHTML = qaDisplay.innerHTML.replace(
    "[Daha cevap isteniyor...]",
    answer
  );
  qaDisplay.scrollTop = qaDisplay.scrollHeight;

  // Update recommended questions if provided again
  recommendedQuestionsContainer.innerHTML = "";
  if (nextQuestions && nextQuestions.length === 3) {
    nextQuestions.forEach((q) => {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = q;
      btn.addEventListener("click", () => {
        askRecommendedQuestion(q);
      });
      recommendedQuestionsContainer.appendChild(btn);
    });
  }
});

async function askRecommendedQuestion(question) {
  // Continue the conversation by asking this recommended question
  answerScreen.style.display = "none";
  mainScreen.style.display = "block";
  displayEl.textContent = `Sorduğunuz: "${question}"\nDüşünüyor...`;
  lastQuestion = question;

  messages.push({ role: "user", content: question });

  try {
    const { answer, nextQuestions } = await getFullResponse(messages);
    messages.push({ role: "assistant", content: answer });
    showAnswerScreen(question, answer, nextQuestions);
  } catch (err) {
    console.error(err);
    displayEl.textContent = "İstek işlenirken hata oluştu.";
    mainScreen.style.display = "block";
    answerScreen.style.display = "none";
  }
}

init();
