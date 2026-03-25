// Firebase Compat - dùng global firebase object (đã load qua CDN trong index.html)
// Không dùng ES module import để hoạt động với file:// protocol

const firebaseConfig = {
  apiKey: "AIzaSyBYb81YHYxgWe99PuQUFBWUnrCRfg1nn6c",
  authDomain: "taazota-86bc8.firebaseapp.com",
  projectId: "taazota-86bc8",
  storageBucket: "taazota-86bc8.firebasestorage.app",
  messagingSenderId: "660931457661",
  appId: "1:660931457661:web:87e3a9d34f45128448b714",
  measurementId: "G-TLNMN7LKJP"
};

const app = firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
// GIỮ Firebase Auth để đăng nhập, KHÔNG dùng Firestore nữa (quá nhiều lỗi kết nối)

// ====== STATE ======
let state = {
    currentUser: null,
    exams: [],
    results: [],
    currentTakingExam: null,
    takingExamAnswers: {}
};

// ====== FIRESTORE REST API CLIENT ======
// Bypass hoàn toàn Firebase SDK (WebSockets) để chống Firewall chặn
const firestoreREST = {
    baseUrl: `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`,
    
    async getToken() {
        if (!auth.currentUser) return null;
        return await auth.currentUser.getIdToken();
    },
    
    // Đọc dữ liệu (Tất cả field đều được parse tự động về định dạng JS)
    async getCollection(collection) {
        const token = await this.getToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        
        // Dùng Promise.race để chặn các timeout network kẹt dài hạn
        const fetchPromise = fetch(`${this.baseUrl}/${collection}?pageSize=300`, { headers });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Mạng quá chậm, quá thời gian chờ tải dữ liệu (15s)')), 15000));
        
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (!res.ok) throw new Error(`Lỗi dữ liệu: HTTP ${res.status}`);
        const data = await res.json();
        if (!data.documents) return [];
        
        return data.documents.map(doc => {
            const id = doc.name.split('/').pop();
            const fields = doc.fields || {};
            const obj = { id };
            
            for (const [k, v] of Object.entries(fields)) {
                if (v.stringValue !== undefined) {
                    let val = v.stringValue;
                    // Auto-parse JSON string (mảng câu hỏi/đáp án)
                    if ((val.startsWith('[') && val.endsWith(']')) || (val.startsWith('{') && val.endsWith('}'))) {
                        try { val = JSON.parse(val); } catch(e) {}
                    }
                    obj[k] = val;
                }
                else if (v.integerValue !== undefined) obj[k] = parseInt(v.integerValue);
                else if (v.doubleValue !== undefined) obj[k] = parseFloat(v.doubleValue);
                else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
            }
            return obj;
        });
    },
    
    // Ghi dữ liệu (Ép array/object thành JSON string để bypass giới hạn định dạng của Firestore REST)
    async addDocument(collection, dataObj) {
        const token = await this.getToken();
        const headers = { 
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        };
        
        const fields = {};
        for (const [k, v] of Object.entries(dataObj)) {
            if (v === null || v === undefined) continue;
            if (typeof v === 'string') fields[k] = { stringValue: v };
            else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: v.toString() } : { doubleValue: v };
            else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
            else fields[k] = { stringValue: JSON.stringify(v) }; // Mảng/Object -> JSON String
        }
        
        // Timeout 60s để up file nặng có base64
        const fetchPromise = fetch(`${this.baseUrl}/${collection}`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ fields })
        });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Mạng quá chậm, quá thời gian chờ lưu dữ liệu (60s)')), 60000));
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || `Lỗi ghi: HTTP ${res.status}`);
        }
        const doc = await res.json();
        return doc.name.split('/').pop();
    },
    
    async updateDocument(collection, docId, dataObj) {
        const token = await this.getToken();
        const headers = { 
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        };
        
        const fields = {};
        for (const [k, v] of Object.entries(dataObj)) {
            if (v === null || v === undefined) continue;
            if (typeof v === 'string') fields[k] = { stringValue: v };
            else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: v.toString() } : { doubleValue: v };
            else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
            else fields[k] = { stringValue: JSON.stringify(v) };
        }
        
        const fetchPromise = fetch(`${this.baseUrl}/${collection}/${docId}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ fields })
        });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Mạng quá chậm (60s)')), 60000));
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || `Lỗi cập nhật: HTTP ${res.status}`);
        }
    },
    
    async deleteDocument(collection, docId) {
        const token = await this.getToken();
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${this.baseUrl}/${collection}/${docId}`, { method: 'DELETE', headers });
        if (!res.ok) throw new Error(`Lỗi xóa: HTTP ${res.status}`);
        return true;
    }
};

async function loadDataFromREST() {
    if (!state.currentUser) return;
    try {
        state.exams = await firestoreREST.getCollection('exams');
        // Sắp xếp đề thi mới nhất lên đầu
        state.exams.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        state.results = await firestoreREST.getCollection('results');
    } catch (error) {
        console.warn('Lỗi tải dữ liệu REST:', error);
        alert('Tải dữ liệu thất bại. Nếu bạn đang dùng mạng bị chặn, hãy thử đổi mạng: ' + error.message);
    }
}

// ====== DOM ELEMENTS ======
const views = {
    auth: document.getElementById('auth-view'),
    teacherDashboard: document.getElementById('teacher-dashboard-view'),
    examCreation: document.getElementById('exam-creation-view'),
    studentDashboard: document.getElementById('student-dashboard-view'),
    takeExam: document.getElementById('take-exam-view'),
    result: document.getElementById('result-view')
};

const header = document.getElementById('main-header');
const welcomeText = document.getElementById('welcome-text');

// ====== ROUTING & UI CONTROL ======
function switchView(viewName) {
    Object.values(views).forEach(v => {
        if (v) {
            v.classList.remove('active');
            v.classList.add('hidden');
        }
    });
    if (views[viewName]) {
        views[viewName].classList.remove('hidden');
        views[viewName].classList.add('active');
        window.scrollTo(0, 0);
    }
}

async function updateAuthUI() {
    if (state.currentUser) {
        header.classList.remove('hidden');
        welcomeText.innerHTML = `Xin chào, <strong>${state.currentUser.username}</strong> (${state.currentUser.role === 'teacher' ? 'Giáo viên' : 'Học sinh'})`;

        await loadDataFromREST();

        if (state.currentUser.role === 'teacher') {
            renderTeacherExams();
            switchView('teacherDashboard');
        } else {
            renderStudentExams();
            switchView('studentDashboard');
        }
    } else {
        header.classList.add('hidden');
        switchView('auth');
    }
}

// ====== AUTHENTICATION ======
let isLoginMode = true;
let pendingUserData = null; // Dùng để truyền dữ liệu đăng ký sang onAuthStateChanged
const authForm = document.getElementById('auth-form');
const toggleAuthBtn = document.getElementById('toggle-auth-btn');
const roleGroup = document.getElementById('role-group');
const loginSubmitBtn = document.getElementById('login-submit-btn');

toggleAuthBtn.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    if (isLoginMode) {
        roleGroup.classList.add('hidden');
        loginSubmitBtn.textContent = 'Đăng nhập';
        toggleAuthBtn.textContent = 'Chưa có tài khoản? Đăng ký ngay';
    } else {
        roleGroup.classList.remove('hidden');
        loginSubmitBtn.textContent = 'Đăng ký';
        toggleAuthBtn.textContent = 'Đã có tài khoản? Đăng nhập';
    }
});

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const passwordInput = document.getElementById('password');
    const password = passwordInput ? passwordInput.value : '123456';
    
    if (!username || !password) return alert('Vui lòng nhập đầy đủ thông tin');
    
    const email = `${username.toLowerCase().replace(/[^a-z0-9]/g, '')}@azota.local`;

    loginSubmitBtn.disabled = true;
    loginSubmitBtn.textContent = 'Đang xử lý...';

    try {
        if (isLoginMode) {
            // === ĐĂNG NHẬP ===
            await auth.signInWithEmailAndPassword(email, password);
            // onAuthStateChanged sẽ tự xử lý phần còn lại
        } else {
            // === ĐĂNG KÝ ===
            let role = document.getElementById('role').value;

            // Lưu dữ liệu đăng ký để onAuthStateChanged dùng
            pendingUserData = { username: username, role: role };

            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            
            // === LƯU ROLE VÀO FIREBASE AUTH PROFILE (CÁCH ĐÁNG TIN CẬY NHẤT) ===
            // displayName lưu dạng "username|role" — luôn có sẵn khi user đăng nhập
            await userCredential.user.updateProfile({
                displayName: username + '|' + role
            });
            
            // Cập nhật state ngay
            state.currentUser = { uid: userCredential.user.uid, username: username, role: role };
            pendingUserData = null;
            
            // Backup: lưu vào localStorage
            localStorage.setItem('azota_user_data', JSON.stringify({
                uid: userCredential.user.uid, username: username, role: role
            }));
            
            // Firestore đã bị loại bỏ vì lỗi kết nối
            // Chỉ lưu local

            
            alert('Đăng ký thành công!');
            updateAuthUI();
        }
    } catch (error) {
        pendingUserData = null;
        if (error.code === 'auth/email-already-in-use') alert('Tên đăng nhập này đã được sử dụng!');
        else if (error.code === 'auth/invalid-credential') alert('Sai tên đăng nhập hoặc mật khẩu!');
        else if (error.code === 'auth/weak-password') alert('Mật khẩu quá yếu (cần ít nhất 6 ký tự)');
        else alert('Lỗi: ' + error.message);
    } finally {
        loginSubmitBtn.disabled = false;
        loginSubmitBtn.textContent = isLoginMode ? 'Đăng nhập' : 'Đăng ký';
    }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    localStorage.removeItem('azota_user_data');
    await auth.signOut();
});

auth.onAuthStateChanged(async (user) => {
    if (user) {
        // Nếu có pendingUserData (vừa đăng ký), dùng dữ liệu đó luôn
        if (pendingUserData) {
            state.currentUser = { uid: user.uid, ...pendingUserData };
            localStorage.setItem('azota_user_data', JSON.stringify(state.currentUser));
            // Đã xóa db.collection("users").set() vì bỏ Firestore
            pendingUserData = null;
        } else if (state.currentUser && state.currentUser.uid === user.uid) {
            // Đã có state, không cần đọc lại
        } else {
            // === ĐĂNG NHẬP HOẶC F5 RELOAD ===
            // Đọc role từ nhiều nguồn, ưu tiên theo thứ tự đáng tin cậy
            let userData = null;
            
            // NGUỒN 1 (TIN CẬY NHẤT): Firebase Auth displayName
            // displayName lưu dạng "username|role" — luôn có sẵn khi user đã đăng nhập
            if (user.displayName && user.displayName.includes('|')) {
                const parts = user.displayName.split('|');
                userData = { username: parts[0], role: parts[1] };
                console.log('Đọc role từ Firebase Auth profile:', userData.role);
            }
            
            // NGUỒN 2: localStorage
            if (!userData) {
                try {
                    const localData = JSON.parse(localStorage.getItem('azota_user_data'));
                    if (localData && localData.uid === user.uid) {
                        userData = { username: localData.username, role: localData.role };
                        console.log('Đọc role từ localStorage:', userData.role);
                    }
                } catch (e) {
                    console.warn('Lỗi đọc localStorage:', e);
                }
            }
            
            // NGUỒN 3: localStorage
            if (!userData) {
                try {
                    const localData = JSON.parse(localStorage.getItem('azota_user_data'));
                    if (localData && localData.uid === user.uid) {
                        userData = { username: localData.username, role: localData.role };
                        console.log('Đọc role từ localStorage:', userData.role);
                    }
                } catch (e) {
                    console.warn('Lỗi đọc localStorage:', e);
                }
            }
            
            // NGUỒN 4: Mặc định (chỉ khi tất cả nguồn đều không có)
            if (userData) {
                state.currentUser = { uid: user.uid, ...userData };
                localStorage.setItem('azota_user_data', JSON.stringify(state.currentUser));
            } else {
                state.currentUser = {
                    uid: user.uid,
                    username: user.email ? user.email.split('@')[0] : 'user',
                    role: 'student'
                };
            }
        }
    } else {
        state.currentUser = null;
    }
    updateAuthUI();
});

// ====== TEACHER: EXAM CREATION WIZARD ======
document.getElementById('create-exam-btn')?.addEventListener('click', () => {
    switchView('examCreation');
    resetWizard();
});

document.querySelectorAll('.back-to-dashboard-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (state.currentUser?.role === 'teacher') switchView('teacherDashboard');
        else switchView('studentDashboard');
    });
});

let currentExtractedQuestions = [];

document.getElementById('upload-area')?.addEventListener('click', () => {
    document.getElementById('file-upload').click();
});

document.getElementById('file-upload')?.addEventListener('change', (e) => {
    const pEl = document.querySelector('#upload-area p');
    if (e.target.files.length > 0 && pEl) {
        pEl.innerHTML = `Đã chọn file: <strong style="color: var(--primary)">${e.target.files[0].name}</strong>`;
    }
});

function resetWizard() {
    document.getElementById('wizard-step-1').classList.remove('hidden');
    document.getElementById('wizard-step-2').classList.add('hidden');
    document.getElementById('wizard-step-3').classList.add('hidden');
    document.getElementById('exam-text-input').value = '';
    document.getElementById('file-upload').value = '';
    const pEl = document.querySelector('#upload-area p');
    if (pEl) pEl.innerHTML = 'Kéo thả file vào đây hoặc <strong>nhấn để chọn file</strong>';
    currentExtractedQuestions = [];
    document.getElementById('generated-questions-container').innerHTML = '';
}

// ===== FILE PARSING AND REAL AI INTEGRATION =====
// Để dùng AI thật, ta sẽ yêu cầu người dùng cung cấp API Key của Google Gemini
let geminiApiKey = localStorage.getItem('ai_exams_gemini_key') || '';

if (!geminiApiKey) {
    // Nếu chưa có, hỏi người dùng chạy lần đầu (Chỉ hỏi GV khi họ mở form)
}

document.getElementById('generate-ai-btn')?.addEventListener('click', async () => {
    const textInput = document.getElementById('exam-text-input').value;
    const fileInput = document.getElementById('file-upload').files[0];

    if (!textInput && !fileInput) {
        return alert('Vui lòng nhập văn bản hoặc tải file lên để AI phân tích.');
    }

    if (!geminiApiKey) {
        const key = prompt('Để AI thật có thể đọc file và tạo câu hỏi, bạn cần nhập Google Gemini API Key của bạn:\n(Bạn có thể lấy miễn phí tại Google AI Studio)');
        if (!key) return alert('Bắt buộc phải có API Key để dùng AI thật.');
        geminiApiKey = key;
        localStorage.setItem('ai_exams_gemini_key', geminiApiKey);
    }

    // Chuyển sang bước Loading
    document.getElementById('wizard-step-1').classList.add('hidden');
    document.getElementById('wizard-step-2').classList.remove('hidden');

    const loadingText = document.querySelector('.loading-state p');
    loadingText.innerHTML = 'Đang đọc nội dung file/văn bản... <br><span id="loading-percent" style="font-weight:bold; color:var(--primary); font-size: 1.25rem;">0%</span>';

    let percentCounter = 0;
    const loadingInterval = setInterval(() => {
        if (percentCounter < 98) {
            // Tốc độ tăng chậm dần để tạo cảm giác đang xử lý thực sự
            const increment = percentCounter < 50 ? Math.floor(Math.random() * 5) + 1 : Math.floor(Math.random() * 2);
            percentCounter += increment;
            if (percentCounter > 98) percentCounter = 98;
            const percentEl = document.getElementById('loading-percent');
            if (percentEl) percentEl.innerText = `${percentCounter}%`;
        }
    }, 400);

    try {
        let extractedText = textInput;

        // Xử lý file nếu có
        if (fileInput) {
            const ext = fileInput.name.split('.').pop().toLowerCase();
            if (ext === 'txt') {
                extractedText = await fileInput.text();
            } else if (ext === 'docx') {
                document.querySelector('.loading-state p').innerText = 'Đang giải mã file Word... (Dùng Mammoth.js)';
                extractedText = await parseDocxFile(fileInput);
            } else if (ext === 'pdf') {
                alert("⚠️ LƯU Ý TỪ HỆ THỐNG:\n\nTrình đọc định dạng PDF hiện tại CHỈ QUÉT ĐƯỢC CHỮ (Text) và sẽ XÓA SẠCH mọi Hình Ảnh trong file PDF để tránh quá tải trình duyệt.\n\nDo đó, đề thi tạo từ file PDF này chắc chắn sẽ KHÔNG CÓ ẢNH.\n👉 ĐỂ CÓ 100% ẢNH PERFECT: Lần sau thầy/cô hãy lưu file dưới dạng WORD (.DOCX) với ảnh chuẩn PNG/JPEG nhé!");
                document.querySelector('.loading-state p').innerText = 'Đang giải mã PDF... (Dùng PDF.js)';
                extractedText = await parsePdfFile(fileInput);
            } else {
                throw new Error('Định dạng file không được hỗ trợ. Chỉ hỗ trợ txt, docx, pdf.');
            }
        }

        if (!extractedText || extractedText.trim() === '') {
            throw new Error('Không thể đọc được nội dung từ file hoặc văn bản nhập vào quá ngắn.');
        }

        const loadingText = document.querySelector('.loading-state p');
        loadingText.innerHTML = 'AI Gemini đang phân tích nội dung và tạo đề... (Vui lòng chờ khoảng 1-3 phút do file có hình ảnh/bảng biểu)<br><span id="loading-percent" style="font-weight:bold; color:var(--primary); font-size: 1.25rem;">' + percentCounter + '%</span>';

        window.lastExtractedText = extractedText;

        // QUAN TRỌNG: Dọn dẹp loading interval trước khi chuyển bước (fix memory leak)
        clearInterval(loadingInterval);

        document.getElementById('wizard-step-2').classList.add('hidden');
        document.getElementById('wizard-step-3').classList.remove('hidden');

        // Gửi toàn bộ nội dung trong 1 lần streaming duy nhất (tránh rate limit)
        await callGeminiAPIStreaming(extractedText, null);


    } catch (error) {
        clearInterval(loadingInterval);
        console.error(error);
        alert('Lỗi: ' + error.message + '\n\n(Nếu lỗi liên quan đến JSON, do file quá lớn/phức tạp khiến bộ nhớ AI bị cắt đứt giữa chừng, hãy thử tạo lại hoặc cắt nhỏ file).');
        if (error.message.includes("403") || error.message.includes("401") || error.message.includes("404")) {
            geminiApiKey = '';
            localStorage.removeItem('ai_exams_gemini_key');
        }
        resetWizard();
    }
});

document.getElementById('change-api-key-btn')?.addEventListener('click', () => {
    const key = prompt('Nhập Google Gemini API Key mới của bạn:\n(Để trống nếu muốn hủy bỏ)');
    if (key) {
        geminiApiKey = key.trim();
        localStorage.setItem('ai_exams_gemini_key', geminiApiKey);
        alert('Đã cập nhật API Key thành công!');
    }
});

// Chuyển đổi DOCX thành Text & HTML thô bằng Mammoth (Sẽ import qua CDN ở index.html)
window.extractedImages = {};
let imageCounter = 0;

async function parseDocxFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (event) {
            const arrayBuffer = event.target.result;
            // Dùng mammoth.js để extract HTML để giữ lại table và img
            if (window.mammoth) {
                const options = {
                    convertImage: mammoth.images.imgElement(function (image) {
                        return image.read("base64").then(function (base64Str) {
                            const imgId = `[IMG_${imageCounter++}]`;
                            let mimeType = image.contentType;
                            if (mimeType.includes("wmf") || mimeType.includes("emf")) {
                                console.warn("Phát hiện ảnh WMF/EMF, có thể bị lỗi hiển thị trình duyệt.");
                                // Trình duyệt không hỗ trợ thư viện vector nhúng nên sẽ thay bằng SVG cảnh báo đỏ
                                const errorSvg = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="auto" viewBox="0 0 300 80" style="background:#fee2e2;border:1px solid #ef4444;border-radius:4px;"><text x="10" y="30" fill="#b91c1c" font-family="Arial" font-size="14" font-weight="bold">⚠️ Lỗi hiển thị ảnh gốc</text><text x="10" y="55" fill="#7f1d1d" font-family="Arial" font-size="12">Sơ đồ/ảnh được lưu dưới dạng WMF/EMF cũ. Hãy dán lại</text><text x="10" y="72" fill="#7f1d1d" font-family="Arial" font-size="12">bằng ảnh PNG/JPEG vào Word.</text></svg>`);
                                window.extractedImages[imgId] = errorSvg;
                                return { src: imgId };
                            }
                            // QUAN TRỌNG: BẮT BUỘC DÙNG BASE64 ĐỂ LƯU VĨNH VIỄN LÊN CLOUD. (Blob URL không thể save database)
                            window.extractedImages[imgId] = "data:" + mimeType + ";base64," + base64Str;
                            return {
                                src: imgId
                            };
                        });
                    })
                };
                mammoth.convertToHtml({ arrayBuffer: arrayBuffer }, options)
                    .then(result => resolve(result.value))
                    .catch(err => reject(err));
            } else {
                reject(new Error("Thư viện Mammoth.js chưa được tải để đọc file Word."));
            }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
    });
}

// Chuyển đổi PDF thành text bằng PDF.js (Sẽ import qua CDN ở index.html)
async function parsePdfFile(file) {
    if (!window['pdfjs-dist/build/pdf']) {
        throw new Error("Thư viện PDF.js chưa được tải.");
    }
    const pdfjsLib = window['pdfjs-dist/build/pdf'];
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = '';

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        text += pageText + '\n\n';
    }
    return text;
}

// Hàm gọi API cho từng chunk với xử lý 429 thông minh
async function callSingleGeminiChunk(chunkText, chunkIndex, statusCallback) {
    const prompt = `Bạn là một chuyên gia trích xuất dữ liệu thân thiện và chính xác. Khách hàng đang cần bạn đọc nội dung dưới đây và trích xuất TOÀN BỘ các câu hỏi ra định dạng JSON Array. Hệ thống đang chờ kết quả từ bạn.

YÊU CẦU QUAN TRỌNG:
1. TRÍCH XUẤT ĐẦY ĐỦ 100%: Xin đừng bỏ sót bất kỳ câu hỏi nào. Hãy duyệt qua toàn bộ nội dung.
2. CHÍNH XÁC TUYỆT ĐỐI: Giữ nguyên văn 100% từng chữ, từng dấu câu. Không tự ý tóm tắt, diễn giải, hay cắt bớt.
3. BẢO TOÀN LỖI HÌNH ẢNH & BẢNG: Bất kỳ thẻ <img src="[IMG_x]"> hay <table> nào CÓ SẴN TRONG VĂN BẢN GỐC cũng PHẢI GIỮ NGUYÊN VẸN 100%.
   -> CẢNH BÁO ĐỎ: NẾU VĂN BẢN GỐC KHÔNG CÓ THẺ [IMG_x], BẠN TUYỆT ĐỐI KHÔNG ĐƯỢC TỰ BỊA RA HAY TỰ CHÈN THÊM BẤT CỨ THẺ ẢNH NÀO VÀO! (Dù câu hỏi có ghi "Quan sát sơ đồ sau", nếu không có sẵn mã [IMG_x] thì cấm tuyệt đối việc tự tạo thẻ <img>).
4. XUỐNG DÒNG VÀ IN ĐẬM: Tuyệt đối KHÔNG dùng LaTeX để định dạng văn bản (không dùng \\\\textbf, \\\\textit). Hãy dùng thẻ HTML như <b>, <i>. Khi xuống dòng trong văn bản, BẮT BUỘC dùng thẻ <br>, không dùng \n.

XỬ LÝ CÔNG THỨC TOÁN HỌC (RẤT QUAN TRỌNG):
- Toán/Lý/Hóa phải dùng chuẩn LaTeX. VĂN BẢN BÌNH THƯỜNG KHÔNG DÙNG LATEX.
- Phải sử dụng dấu chéo kép (\\\\) cho TẤT CẢ các lệnh LaTeX. (Ví dụ: \\\\frac, \\\\int).
- Ví dụ ĐÚNG: \\\\( \\\\int x^2 dx \\\\). KHÔNG dùng mã Unicode thô như ∫, √, ∑, ≥.

ĐỊNH DẠNG ĐẦU RA VÀ PHÂN LOẠI CÂU HỎI (QUAN TRỌNG NHẤT):
1. Dạng Trắc nghiệm 1 đáp án (A, B, C, D): BẮT BUỘC gộp chung thành 1 Question duy nhất có type: "single", với 4 options. KHÔNG được cắt vụn 1 câu trắc nghiệm thành 4 câu Đúng/Sai.
  -> Output: {"type": "single", "content": "...", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "correctAnswer": 0}
2. Dạng Đúng/Sai chuẩn 2025 (1 câu hỏi lớn có 4 mệnh đề con a,b,c,d để tick Đ/S): BẮT BUỘC gộp 4 mệnh đề này vào 1 Question duy nhất có type: "multiple". Mệnh đề ĐÚNG thì ghi index vào correctAnswer. TUYỆT ĐỐI KHÔNG tự tách thành 4 câu hỏi đơn lẻ.
  -> Output: {"type": "multiple", "content": "...", "options": ["a) ...", "b) ...", "c) ...", "d) ..."], "correctAnswer": [0, 1]}
3. Câu hỏi ngắn (Tự luận ngắn): {"type": "short", "content": "...", "correctAnswer": "đáp án"} -> Nếu không có đáp án, hãy để chuỗi rỗng "". TUYỆT ĐỐI KHÔNG để null.

Nội dung phần ${chunkIndex}:
---
${chunkText.substring(0, 100000)}
---`;

    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { 
                        temperature: 0.0, 
                        maxOutputTokens: 8192
                    }
                })
            });

            if (response.ok) {
                const data = await response.json();
                const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                let text = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
                text = text.replace(/[\u0000-\u0009\u000B-\u001F]+/g, " ");



                const firstBracket = text.indexOf('[');
                const lastBracket = text.lastIndexOf(']');
                if (firstBracket !== -1 && lastBracket !== -1) {
                    text = text.substring(firstBracket, lastBracket + 1);
                }

                try {
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        console.log(`Chunk ${chunkIndex}: ✅ ${parsed.length} câu`);
                        return parsed;
                    }
                } catch (e) { }

                const partial = tryParsePartial(rawText);
                if (partial && partial.length > 0) {
                    console.log(`Chunk ${chunkIndex}: ✅ (partial) ${partial.length} câu`);
                    return partial;
                }
                return [];

            } else if (response.status === 429) {
                let waitSecs = 62;
                try {
                    const errData = await response.json();
                    const msg = errData.error?.message || '';
                    const match = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
                    if (match) waitSecs = Math.ceil(parseFloat(match[1])) + 5;
                } catch (e) { }

                if (attempt < MAX_ATTEMPTS) {
                    console.log(`Chunk ${chunkIndex}: Rate limit, đang đợi ${waitSecs}s...`);
                    for (let s = waitSecs; s > 0; s--) {
                        if (statusCallback) statusCallback(`⏳ Phần ${chunkIndex}: đợi rate limit... còn ${s}s`);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    continue;
                }
                return [];

            } else if (response.status === 400) {
                const errData = await response.json().catch(() => ({}));
                if ((errData.error?.message || '').toLowerCase().includes('key not valid')) throw new Error('API Key không hợp lệ');
                return [];
            } else {
                return [];
            }
        } catch (err) {
            if (err.message.includes('API Key')) throw err;
            console.warn(`Chunk ${chunkIndex} network lỗi:`, err.message);
            return [];
        }
    }
    return [];
}

window.getAvailableModels = async function(apiKey) {
    try {
        const modelListRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if(modelListRes.ok) {
            const data = await modelListRes.json();
            if (data.models) {
                let models = data.models
                    .filter(m => m.supportedGenerationMethods?.includes("generateContent") && m.name.includes('gemini'))
                    .map(m => m.name.split('/').pop());
                
                models.sort((a,b) => {
                    const scoreA = (a.includes('1.5-flash') && !a.includes('8b')) ? 10 : 0;
                    const scoreB = (b.includes('1.5-flash') && !b.includes('8b')) ? 10 : 0;
                    return scoreB - scoreA;
                });
                if(models.length > 0) return models;
            }
        }
    } catch(err) {
        console.warn('API model fetch fail', err);
    }
    return ['gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-1.5-pro-latest'];
};

// Gọi API Gemini Streaming
async function callGeminiAPIStreaming(contextText, continueFromQ = null) {
    let prompt = `Bạn là một chuyên gia đào tạo và hệ thống tự động đang dựa vào bạn. Nhiệm vụ của bạn là đọc nội dung (định dạng văn bản/HTML) và trích xuất TOÀN BỘ các câu hỏi ra mảng JSON.

YÊU CẦU QUAN TRỌNG (HÃY ĐỌC KỸ TRƯỚC KHI BẮT ĐẦU):
1. TRÍCH XUẤT ĐẦY ĐỦ 100%: Xin đừng bỏ sót hay nhảy cóc bất kỳ câu hỏi nào. Hãy duyệt từng dòng một cho đến hết.
2. CHÍNH XÁC TUYỆT ĐỐI (Nguyên bản): Giữ nguyên văn 100% từng chữ, từng dấu câu. KHÔNG tóm tắt hay diễn giải.
3. BẢO TOÀN LỖI HÌNH ẢNH & BẢNG: Bất kỳ thẻ <img src="[IMG_x]"> hay <table> nào CÓ SẴN TRONG VĂN BẢN GỐC cũng PHẢI GIỮ NGUYÊN VẸN 100%.
   -> CẢNH BÁO ĐỎ: NẾU VĂN BẢN GỐC KHÔNG CÓ THẺ [IMG_x], BẠN TUYỆT ĐỐI KHÔNG ĐƯỢC TỰ BỊA RA HAY TỰ CHÈN THÊM BẤT CỨ THẺ ẢNH NÀO VÀO! (Dù câu hỏi có ghi "Quan sát sơ đồ sau", nếu không tìm thấy mã [IMG_x] thì cấm tuyệt đối việc tự tạo thẻ <img>).
4. XUỐNG DÒNG VÀ IN ĐẬM: Tuyệt đối KHÔNG dùng LaTeX để định dạng văn bản (như \\textbf, \\textit). Hãy dùng thẻ HTML như <b>, <i>. Khi cần xuống dòng, BẮT BUỘC DÙNG THẺ <br>, tuyệt đối không dùng ký tự \n.

XỬ LÝ CÔNG THỨC TOÁN HỌC (BẮT BUỘC):
- Chuyển mọi công thức (toán/lý/hóa) về chuẩn LaTeX. LƯU Ý: VĂN BẢN BÌNH THƯỜNG KHÔNG DÙNG LATEX.
- Bạn phải sử dụng dấu chéo kép (\\\\) cho TẤT CẢ các lệnh LaTeX Toán học. (Ví dụ: \\\\frac, \\\\int).
- Ví dụ: \\\\( \\\\int x^2 dx \\\\) (không dùng Unicode thô).

ĐỊNH DẠNG ĐẦU RA VÀ PHÂN LOẠI CÂU HỎI (QUAN TRỌNG NHẤT):
1. Dạng Trắc nghiệm 1 đáp án (A, B, C, D): BẮT BUỘC gộp chung thành 1 Question duy nhất có type: "single", với 4 options. KHÔNG được cắt vụn 1 câu trắc nghiệm thành 4 câu Đúng/Sai riêng lẻ.
  -> Output: {"type": "single", "content": "...", "options": ["A...", "B...", "C...", "D..."], "correctAnswer": 0}
2. Dạng Đúng/Sai chuẩn 2025 (1 câu hỏi lớn có 4 mệnh đề con a,b,c,d để tick Đ/S): BẮT BUỘC gộp 4 mệnh đề này vào 1 Question duy nhất có type: "multiple". Mệnh đề ĐÚNG thì ghi index. TUYỆT ĐỐI KHÔNG tự tách thành 4 câu hỏi đơn lẻ.
  -> Output: {"type": "multiple", "content": "...", "options": ["a) ...", "b) ...", "c) ...", "d) ..."], "correctAnswer": [0, 1]}
3. Câu hỏi ngắn: {"type": "short", "content": "...", "correctAnswer": "đáp án"} -> Nếu không có đáp án, hãy để chuỗi rỗng "". TUYỆT ĐỐI KHÔNG để null.`;

    if (continueFromQ) {
        prompt += `\n\nHỆ THỐNG VỪA BỊ NGẮT KẾT NỐI. Bạn hãy bắt đầu trích xuất TỪ CÂU TIẾP THEO ngay sau câu hỏi này (Bỏ qua câu báo này, chỉ làm từ câu kế tiếp):
"${continueFromQ}"`;
    }

    prompt += `\n\nNội dung cần trích xuất:
------------------
${contextText.substring(0, 500000)}
------------------`;

    const activeApiKey = window.geminiApiKey || localStorage.getItem('ai_exams_gemini_key') || firebaseConfig.apiKey;
    let modelsToTry = await window.getAvailableModels(activeApiKey);

    let lastErrorDetails = '';
    let primaryError = null; // Lưu lỗi thật sự (không phải 404 do sai tên model)
    let lastStatus = 0;
    let success = false;

    const container = document.getElementById('generated-questions-container');
    const loadingMsgContainer = document.createElement('div');
    loadingMsgContainer.id = 'stream-loading-msg';
    loadingMsgContainer.style.cssText = 'text-align: center; color: var(--primary); padding: 2rem;';
    loadingMsgContainer.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Chờ chút nhé, AI đang nặn từng câu hỏi ra cho bạn... <br><span id="internal-percent">0%</span>';
    container.appendChild(loadingMsgContainer);

    if (!continueFromQ) {
        currentExtractedQuestions = [];
        container.innerHTML = '';
        container.appendChild(loadingMsgContainer);
    }

    let rawAccumulatedOutput = "";
    let renderedCount = continueFromQ ? currentExtractedQuestions.length : 0;

    for (const model of modelsToTry) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${activeApiKey}`;
        console.log(`Đang thử API Streaming với model: ${model}...`);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.0,
                        maxOutputTokens: 65536
                    }
                })
            });

            if (response.ok) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");
                success = true;

                let buffer = '';
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Giữ lại dòng cuối cùng (chưa hoàn thiện) vào buffer

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (trimmedLine.startsWith('data: ')) {
                            const jsonStr = trimmedLine.substring(6).trim();
                            if (jsonStr === "[DONE]") continue;
                            try {
                                const data = JSON.parse(jsonStr);
                                if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts.length > 0) {
                                    rawAccumulatedOutput += data.candidates[0].content.parts[0].text;

                                    // Parse incremental
                                    let parsed = tryParsePartial(rawAccumulatedOutput);
                                    if (parsed && parsed.length > renderedCount) {
                                        // Update internal loading text so user visualizes action
                                        const internalPercent = document.getElementById('internal-percent');
                                        if (internalPercent) {
                                            let currentP = parseInt(document.getElementById('loading-percent')?.innerText || "0");
                                            internalPercent.innerText = `${currentP}% - Đã xử lý và in ra ${parsed.length} câu...`;
                                        }

                                        const restoreImages = (text) => {
                                            if (!text || typeof text !== 'string') return text;
                                            return text.replace(/\[?\s*IMG_(\d+)\s*\]?/gi, (match, p1) => {
                                                const key = `[IMG_${p1}]`;
                                                return window.extractedImages[key] || match;
                                            });
                                        };

                                        for (let i = renderedCount; i < parsed.length; i++) {
                                            let q = parsed[i];
                                            const restoredOptions = q.options ? q.options.map(o => restoreImages(o)) : undefined;
                                            const restoredCorrectAnswer = (q.type === 'short') ? restoreImages(q.correctAnswer) : q.correctAnswer;
                                            q = {
                                                ...q,
                                                content: restoreImages(q.content),
                                                options: restoredOptions,
                                                correctAnswer: restoredCorrectAnswer,
                                                id: Date.now().toString() + "-" + i
                                            };
                                            currentExtractedQuestions.push(q);

                                            // Append UI
                                            const qEl = createQuestionElement(q, i);
                                            container.insertBefore(qEl, document.getElementById('stream-loading-msg'));
                                        }
                                        renderedCount = parsed.length;
                                    }
                                }
                            } catch (e) { }
                        }
                    }
                }
                
                // Nếu đọc xong stream mà báo lỗi cú pháp JSON toàn cục thì parse thử 1 lần cuối
                try {
                    let finalText = rawAccumulatedOutput.replace(/```json/gi, '').replace(/```/g, '').trim();
                    const firstBracket = finalText.indexOf('[');
                    const lastBracket = finalText.lastIndexOf(']');
                    if (firstBracket !== -1 && lastBracket !== -1) {
                        const arr = JSON.parse(finalText.substring(firstBracket, lastBracket + 1));
                        if (Array.isArray(arr) && arr.length > renderedCount) {
                            // Gọi partial render logic ở trên
                            const p = tryParsePartial(rawAccumulatedOutput);
                            // logic xử lý (để đơn giản đã có hàm catch)
                        }
                    }
                } catch(e) {}

                break; // Thoát vòng lặp models
            } else {
                let errorDetails = '';
                try {
                    const errorJson = await response.json();
                    errorDetails = errorJson.error ? errorJson.error.message : JSON.stringify(errorJson);
                } catch (e) {
                    errorDetails = response.statusText;
                }

                lastStatus = response.status;
                lastErrorDetails = errorDetails;
                
                // Lưu lại lỗi đầu tiên không phải 404 (thường là lỗi 429 Quota hoặc 400 Bad Request)
                if (response.status !== 404 && !primaryError) {
                    primaryError = errorDetails;
                }

                console.warn(`Model ${model} thất bại:`, errorDetails);

                if (response.status === 400 && errorDetails.toLowerCase().includes("key not valid")) {
                    throw new Error("API Key không hợp lệ hoặc không tồn tại.");
                }
            }
        } catch (err) {
            console.error(`Lỗi mạng khi thử model ${model}:`, err);
            lastErrorDetails = err.message;
            if (!primaryError) primaryError = err.message;
        }
    }

    if (currentExtractedQuestions.length === 0) {
        let finalError = primaryError || lastErrorDetails || "Tất cả model đều thất bại.";
        
        // Dịch lỗi Quota 429 sang tiếng Việt cực kỳ thân thiện
        if (finalError.toLowerCase().includes("quota") || finalError.toLowerCase().includes("limit: 0")) {
            finalError = "Tài khoản (API Key) của bạn đã hết giới hạn sử dụng miễn phí (Quota Exceeded) hoặc không được cấp quyền cho các model AI mới. Bạn cần tạo một API Key mới (bằng tài khoản Google khác) hoặc nâng cấp thẻ thanh toán trên Google AI Studio.";
        }
        
        let errorMsg = `AI không tạo được câu hỏi.\n\nNGUYÊN NHÂN: ${finalError}`;
        throw new Error(errorMsg);
    }

    const loadingMsgObj = document.getElementById('stream-loading-msg');
    if (loadingMsgObj) loadingMsgObj.remove();
}

function tryParsePartial(text) {
    let cleanStr = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    const firstBracketIndex = cleanStr.indexOf('[');
    if (firstBracketIndex === -1) return null;

    let arrayStr = cleanStr.substring(firstBracketIndex);

    const lastBraceIndex = arrayStr.lastIndexOf('}');
    if (lastBraceIndex === -1) return null;

    let partialStr = arrayStr.substring(0, lastBraceIndex + 1) + ']';
    partialStr = partialStr.replace(/[\u0000-\u0009\u000B-\u001F]+/g, " ");

    try {
        let parsed = JSON.parse(partialStr);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        // Cứu hộ: thử bỏ object cuối cùng đi nếu object đó đang viết dở có chứa ký tự '}' trong string
        let searchIndex = partialStr.length - 3;
        while (searchIndex > 0) {
            const tempBrace = partialStr.lastIndexOf('}', searchIndex);
            if (tempBrace === -1) break;
            let fallbackStr = partialStr.substring(0, tempBrace + 1) + ']';
            try {
                let parsed = JSON.parse(fallbackStr);
                return Array.isArray(parsed) ? parsed : [];
            } catch (e2) {
                searchIndex = tempBrace - 1;
            }
        }
        return null;
    }
}

// ====== KATEX MATH RENDERING ======
function renderMath(element) {
    if (window.renderMathInElement && element) {
        try {
            renderMathInElement(element, {
                delimiters: [
                    { left: '\\[', right: '\\]', display: true },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false }
                ],
                throwOnError: false,
                trust: true
            });
        } catch (e) {
            console.warn('KaTeX render error:', e);
        }
    }
}

function createQuestionElement(q, index) {
    const qEl = document.createElement('div');
    qEl.className = 'question-item';
    qEl.id = `q-item-${q.id}`;
    qEl.style.animation = "fadeIn 0.5s ease";

    let typeLabel = '';
    if (q.type === 'single') typeLabel = 'Trắc nghiệm (1 đáp án)';
    if (q.type === 'multiple') typeLabel = 'Đúng/Sai (Nhiều đáp án)';
    if (q.type === 'short') typeLabel = 'Câu hỏi ngắn';

    // Xử lý content: Nếu AI vẫn dùng \n thì format lại thành <br>
    let formatContent = q.content || "";
    formatContent = formatContent.replace(/\n/g, '<br>');

    let optionsHtml = '';
    if (q.type === 'single') {
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        optionsHtml = `<div class="options-list">
            ${rawOptions.map((opt, i) => {
            const isCorrect = q.correctAnswer === i;
            const formattedOpt = (opt || "").replace(/\n/g, '<br>');
            return `<div class="option-item ${isCorrect ? 'bg-green-50' : ''}">
                    <i class="fa-solid fa-${isCorrect ? 'check text-success' : 'circle text-muted'}"></i>
                    <span>${formattedOpt}</span>
                </div>`;
        }).join('')}
        </div>`;
    } else if (q.type === 'multiple') {
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        optionsHtml = `<div class="options-list">
            ${rawOptions.map((opt, i) => {
            const isCorrect = Array.isArray(q.correctAnswer) && q.correctAnswer.includes(i);
            const formattedOpt = (opt || "").replace(/\n/g, '<br>');
            return `<div class="option-item" style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <span>${formattedOpt}</span>
                    <div style="display:flex; gap:0.2rem; margin-left:1rem; flex-shrink:0;">
                        <span style="padding:0.2rem 0.5rem; border-radius:4px; font-weight:bold; font-size:0.85em; ${isCorrect ? 'background:#d1fae5; color:#065f46;' : 'background:#f3f4f6; color:#9ca3af;'}">Đúng</span>
                        <span style="padding:0.2rem 0.5rem; border-radius:4px; font-weight:bold; font-size:0.85em; ${!isCorrect ? 'background:#fee2e2; color:#991b1b;' : 'background:#f3f4f6; color:#9ca3af;'}">Sai</span>
                    </div>
                </div>`;
        }).join('')}
        </div>`;
    } else {
        let displayAnswer = (q.correctAnswer === null || q.correctAnswer === undefined || q.correctAnswer === "") ? "Chưa có đáp án" : q.correctAnswer;
        optionsHtml = `<div class="mt-2 text-success"><i class="fa-solid fa-key"></i> Đáp án: <strong>${displayAnswer}</strong></div>`;
    }

    qEl.innerHTML = `
        <div class="question-item-header">
            <strong>Câu ${index + 1}</strong>
            <div style="display:flex; gap: 0.5rem; align-items: center;">
                <span class="q-type-badge">${typeLabel}</span>
                <button onclick="moveQuestionOrder('${q.id}', -1)" ${index === 0 ? 'disabled' : ''} class="btn btn-sm btn-outline" title="Lên trên" style="padding: 0.2rem 0.5rem;"><i class="fa-solid fa-arrow-up"></i></button>
                <button onclick="moveQuestionOrder('${q.id}', 1)" ${index === currentExtractedQuestions.length - 1 ? 'disabled' : ''} class="btn btn-sm btn-outline" title="Xuống dưới" style="padding: 0.2rem 0.5rem;"><i class="fa-solid fa-arrow-down"></i></button>
                <button onclick="openEditQuestion('${q.id}')" class="btn btn-sm btn-outline" title="Chỉnh sửa chi tiết" style="padding: 0.2rem 0.5rem;"><i class="fa-solid fa-pen"></i></button>
                <button onclick="deleteGeneratedQuestion('${q.id}')" class="btn btn-sm btn-danger" title="Xóa" style="padding: 0.2rem 0.5rem;"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
        <div class="q-content">${formatContent}</div>
        ${optionsHtml}
    `;
    // Render công thức toán học LaTeX bên trong câu hỏi
    renderMath(qEl);
    return qEl;
}

window.openEditQuestion = function (qId) {
    let modal = document.getElementById('edit-q-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'edit-q-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
        document.body.appendChild(modal);
    }
    
    const originalQ = currentExtractedQuestions.find(x => x.id === qId);
    if (!originalQ) return;
    window.tempEditingQ = JSON.parse(JSON.stringify(originalQ));
    
    renderEditModalBody();
};

window.renderEditModalBody = function() {
    let modal = document.getElementById('edit-q-modal');
    if (!modal) return;
    const q = window.tempEditingQ;
    if (!q) return;

    const rawOptions = Array.isArray(q.options) ? q.options : ['', '', '', ''];
    let optInputs = '';
    let correctAnswerSection = '';
    
    if (q.type !== 'short') {
        optInputs = rawOptions.map((opt, i) => `
            <div class="input-group" style="margin-bottom: 0.5rem;">
                <label>Phương án ${String.fromCharCode(65 + i)}</label>
                <input type="text" id="edit-opt-${i}" value="${opt.replace(/"/g, '&quot;')}" style="width:100%">
            </div>
        `).join('');
    }

    if (q.type === 'short') {
        correctAnswerSection = `<div class="input-group"><label>Đáp án đúng</label><input type="text" id="edit-correct" value="${q.correctAnswer || ''}"></div>`;
    } else if (q.type === 'multiple') {
        const arr = Array.isArray(q.correctAnswer) ? q.correctAnswer : [];
        const checks = rawOptions.map((_, i) => `
            <label style="margin-right:1rem; cursor:pointer;"><input type="checkbox" id="edit-correct-mul-${i}" ${arr.includes(i) ? 'checked' : ''}> Mệnh đề ${String.fromCharCode(65 + i)} ĐÚNG</label>
        `).join('');
        correctAnswerSection = `<div class="input-group"><label>Chọn các mệnh đề ĐÚNG:</label><div style="margin-top:0.5rem;">${checks}</div></div>`;
    } else {
        correctAnswerSection = `<div class="input-group"><label>Index đáp án đúng (0=A, 1=B, 2=C, 3=D)</label><input type="number" id="edit-correct" min="0" max="3" value="${q.correctAnswer ?? 0}"></div>`;
    }

    modal.innerHTML = `
        <div style="background:white;border-radius:1rem;padding:2rem;width:90%;max-width:700px;max-height:90vh;overflow-y:auto; position: relative;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem;">
                <h3>Chỉnh sửa câu hỏi</h3>
                <button class="btn btn-outline btn-sm" onclick="document.getElementById('edit-q-modal').remove()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            
            <div style="background: #eef2ff; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
                <span style="font-weight: 600; margin-right: 0.5rem; color: #4338ca;"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Tools:</span>
                <button id="ai-btn-rewrite" class="btn btn-sm btn-primary" onclick="requestAIMicroTool('rewrite')">✨ Làm rõ câu hỏi</button>
                <button id="ai-btn-harder" class="btn btn-sm btn-primary" onclick="requestAIMicroTool('harder')">✨ Tăng độ khó</button>
                <button id="ai-btn-similar" class="btn btn-sm btn-outline" onclick="requestAIMicroTool('similar')">✨ Tạo câu tương tự</button>
            </div>

            <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
                <div class="input-group" style="flex:1">
                    <label>Dạng câu hỏi</label>
                    <select id="edit-type" onchange="changeEditType()">
                        <option value="single" ${q.type === 'single' ? 'selected' : ''}>Trắc nghiệm (1 đáp án)</option>
                        <option value="multiple" ${q.type === 'multiple' ? 'selected' : ''}>Đúng/Sai (Nhiều đáp án)</option>
                        <option value="short" ${q.type === 'short' ? 'selected' : ''}>Câu hỏi tự luận ngắn</option>
                    </select>
                </div>
                <div class="input-group" style="flex:1">
                    <label>Mức độ (Difficulty)</label>
                    <select id="edit-difficulty">
                        <option value="easy" ${q.difficulty === 'easy' ? 'selected' : ''}>Nhận biết (Dễ)</option>
                        <option value="medium" ${q.difficulty === 'medium' || !q.difficulty ? 'selected' : ''}>Thông hiểu (Trung bình)</option>
                        <option value="hard" ${q.difficulty === 'hard' ? 'selected' : ''}>Vận dụng (Khó)</option>
                    </select>
                </div>
            </div>

            <div class="input-group"><label>Nội dung câu hỏi</label><textarea id="edit-content" rows="4" style="width:100%">${q.content || ''}</textarea></div>
            ${optInputs}
            ${correctAnswerSection}
            
            <div class="input-group mt-4">
                <label><i class="fa-solid fa-lightbulb"></i> Lời giải chi tiết / Giải thích</label>
                <textarea id="edit-explanation" rows="3" style="width:100%" placeholder="Nhập lời giải để học sinh xem sau khi nộp bài...">${q.explanation || ''}</textarea>
            </div>
            
            <div style="display:flex; gap:0.5rem; margin-top:2rem;">
                <button class="btn btn-primary" onclick="saveEditQuestion()">Lưu thay đổi</button>
                <button class="btn btn-outline" onclick="document.getElementById('edit-q-modal').remove()">Hủy</button>
            </div>
        </div>`;
};

window.scrapeEditModalToTemp = function() {
    const q = window.tempEditingQ;
    if(!q) return;
    
    q.content = document.getElementById('edit-content').value;
    q.explanation = document.getElementById('edit-explanation').value;
    q.difficulty = document.getElementById('edit-difficulty').value;
    q.type = document.getElementById('edit-type').value;

    if (q.type === 'multiple') {
        const rawOptions = Array.isArray(q.options) ? q.options : ['', '', '', ''];
        q.options = rawOptions.map((_, i) => document.getElementById(`edit-opt-${i}`)?.value || '');
        const correctArr = [];
        for (let i = 0; i < rawOptions.length; i++) {
            if (document.getElementById(`edit-correct-mul-${i}`)?.checked) correctArr.push(i);
        }
        q.correctAnswer = correctArr;
    } else if (q.type === 'single') {
        const rawOptions = Array.isArray(q.options) ? q.options : ['', '', '', ''];
        q.options = rawOptions.map((_, i) => document.getElementById(`edit-opt-${i}`)?.value || '');
        q.correctAnswer = parseInt(document.getElementById('edit-correct').value) || 0;
    } else {
        q.correctAnswer = document.getElementById('edit-correct').value;
    }
};

window.requestAIMicroTool = async function(actionType) {
    scrapeEditModalToTemp();
    const q = window.tempEditingQ;
    if (!q) return;

    let systemPrompt = '';
    const qJsonStr = JSON.stringify({ content: q.content, options: q.options, correctAnswer: q.correctAnswer, type: q.type });

    if (actionType === 'rewrite') {
        systemPrompt = `Dưới đây là một câu hỏi JSON: ${qJsonStr}. Hãy viết lại nội dung câu hỏi và các phương án cho rành mạch, dễ hiểu, chuẩn xác về mặt ngữ pháp hơn NHƯNG KHÔNG thay đổi bản chất và đáp án đúng. TRẢ VỀ DUY NHẤT 1 OBJECT JSON ĐÚNG ĐỊNH DẠNG CỦA CÂU HỎI TRÊN. KHÔNG GIẢI THÍCH, CHỈ CÓ JSON.`;
    } else if (actionType === 'harder') {
        systemPrompt = `Dưới đây là câu hỏi gốc JSON: ${qJsonStr}. Hãy nâng cấp câu hỏi này lên mức độ khó hơn (Vận dụng/Vận dụng cao) bằng cách hỏi sâu hơn, thay đổi thông số/điều kiện phức tạp hơn, hoặc tạo nhiễu cực mạnh cho các đáp án sai. TRẢ VỀ DUY NHẤT 1 OBJECT JSON ĐÚNG ĐỊNH DẠNG. KHÔNG GIẢI THÍCH.`;
    } else if (actionType === 'similar') {
        systemPrompt = `Dựa trên câu hỏi mẫu JSON này: ${qJsonStr}. Hãy SÁNG TẠO ra 1 câu hỏi HOÀN TOÀN MỚI nhưng có cấu trúc và mảng kiến thức tương tự (chỉ thay số, đổi bối cảnh). TRẢ VỀ DUY NHẤT 1 OBJECT JSON ĐÚNG QUY CHUẨN. KHÔNG GIẢI THÍCH.`;
    }

    const btnIdMap = { 'rewrite': 'ai-btn-rewrite', 'harder': 'ai-btn-harder', 'similar': 'ai-btn-similar' };
    const btn = document.getElementById(btnIdMap[actionType]);
    const oldText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Chờ AI...';
    btn.disabled = true;

    try {
        const apiKey = window.geminiApiKey || localStorage.getItem('ai_exams_gemini_key') || firebaseConfig.apiKey;
        const models = await getAvailableModels(apiKey);
        const genModel = models[0];

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${genModel}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: systemPrompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        if (!response.ok) throw new Error('Google AI từ chối kết nối (Mạng Hoặc Quota).');
        const data = await response.json();
        let text = data.candidates[0].content.parts[0].text;
        
        let newQ = null;
        try {
            newQ = JSON.parse(text);
        } catch(parErr) {
            const arr = tryParsePartial(text);
            if(arr && arr.length > 0) newQ = arr[0];
            else throw new Error("AI trả về mã JSON hỏng. Hãy thử lại!");
        }
        
        if (Array.isArray(newQ)) newQ = newQ[0];
        
        if (actionType === 'similar') {
            newQ.id = Date.now().toString() + "-ai-sim";
            currentExtractedQuestions.splice(currentExtractedQuestions.findIndex(x=>x.id===q.id)+1, 0, newQ);
            renderGeneratedQuestions();
            alert('✨ AI đã tạo và TỰ ĐỘNG CHÈN 1 câu hỏi tương tự vào ngay bên dưới danh sách!');
        } else {
            q.content = newQ.content || q.content;
            if (newQ.options) q.options = newQ.options;
            if (newQ.correctAnswer !== undefined) q.correctAnswer = newQ.correctAnswer;
            q.explanation = newQ.explanation || q.explanation;
            if (actionType === 'harder') q.difficulty = 'hard';
            renderEditModalBody();
        }

    } catch(e) {
        alert('Lỗi AI: ' + e.message);
        btn.innerHTML = oldText;
        btn.disabled = false;
    }
};

window.changeEditType = function() {
    scrapeEditModalToTemp();
    const q = window.tempEditingQ;
    if (q.type === 'short') { q.options = []; if(typeof q.correctAnswer === 'number') q.correctAnswer = ""; }
    else if (q.type === 'multiple') { q.correctAnswer = []; if(q.options.length < 4) q.options = ['','','','']; }
    else { q.correctAnswer = 0; if(!q.options || q.options.length < 4) q.options = ['','','','']; }
    renderEditModalBody();
};

window.saveEditQuestion = function () {
    scrapeEditModalToTemp();
    const qId = window.tempEditingQ.id;
    const idx = currentExtractedQuestions.findIndex(x => x.id === qId);
    if (idx !== -1) {
        currentExtractedQuestions[idx] = JSON.parse(JSON.stringify(window.tempEditingQ));
        renderGeneratedQuestions();
    }
    document.getElementById('edit-q-modal').remove();
    window.tempEditingQ = null;
};

window.openQuestionBank = function() {
    let modal = document.getElementById('qbank-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'qbank-modal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;';
        document.body.appendChild(modal);
    }
    
    const teacherExams = state.exams.filter(e => e.author === state.currentUser.username);
    let allQuestions = [];
    teacherExams.forEach(ex => {
        if(Array.isArray(ex.questions)) {
            ex.questions.forEach(q => {
                allQuestions.push({...q, _sourceExam: ex.title});
            });
        }
    });

    window.qBankData = allQuestions.reverse();
    
    renderQBankModal();
};

window.renderQBankModal = function(filterText = '') {
    const modal = document.getElementById('qbank-modal');
    if(!modal) return;
    
    const filtered = (window.qBankData || []).filter(q => {
        if(!filterText) return true;
        return (q.content || '').toLowerCase().includes(filterText.toLowerCase());
    });

    const listHtml = filtered.map((q, i) => `
        <div style="border:1px solid #e5e7eb; border-radius:8px; padding:1rem; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:flex-start;">
            <div style="flex:1; padding-right:1rem;">
                <div style="font-size:0.8rem; color:#6b7280; margin-bottom:0.5rem;"><i class="fa-solid fa-book"></i> Nguồn: ${q._sourceExam}</div>
                <div>${(q.content || '').replace(/\\n/g, '<br>')}</div>
                <div style="margin-top:0.5rem; font-size:0.85rem; color:#4338ca;">
                    <i class="fa-solid fa-tag"></i> Dạng: ${q.type === 'single' ? 'Trắc nghiệm 1 đáp án' : (q.type==='multiple' ? 'Nhiều đáp án (Đ/S)' : 'Tự luận')}
                    &nbsp;&nbsp;|&nbsp;&nbsp; 
                    <i class="fa-solid fa-signal"></i> Độ khó: ${q.difficulty === 'hard' ? 'Khó' : (q.difficulty==='easy' ? 'Dễ' : 'Trung bình (Mặc định)')}
                </div>
            </div>
            <button class="btn btn-sm btn-outline" onclick="addQFromBank(${window.qBankData.indexOf(q)})" style="flex-shrink:0;"><i class="fa-solid fa-plus"></i> Chọn</button>
        </div>
    `).join('');

    modal.innerHTML = `
        <div style="background:white;border-radius:1rem;padding:2rem;width:90%;max-width:800px;max-height:90vh;overflow-y:auto; position:relative;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:1rem;">
                <h3 style="margin:0;"><i class="fa-solid fa-database text-primary"></i> Ngân hàng câu hỏi (${window.qBankData?.length || 0} câu)</h3>
                <button class="btn btn-outline btn-sm" onclick="document.getElementById('qbank-modal').remove()"><i class="fa-solid fa-xmark"></i></button>
            </div>
            
            <input type="text" placeholder="🔍 Tìm kiếm nội dung câu hỏi..." style="width:100%; padding:0.75rem; border:1px solid #ccc; border-radius:8px; margin-bottom:1.5rem;" onkeyup="renderQBankModal(this.value)" value="${filterText}">
            
            <div style="height:500px; overflow-y:auto; padding-right:0.5rem;">
                ${filtered.length > 0 ? listHtml : '<div style="text-align:center; padding:2rem; color:#6b7280;">Không tìm thấy câu hỏi phù hợp.</div>'}
            </div>
        </div>
    `;
};

window.addQFromBank = function(index) {
    const qRaw = window.qBankData[index];
    if(!qRaw) return;
    
    const newQ = JSON.parse(JSON.stringify(qRaw));
    delete newQ._sourceExam;
    newQ.id = Date.now().toString() + "-bank";
    
    currentExtractedQuestions.push(newQ);
    renderGeneratedQuestions();
    
    setTimeout(() => {
        window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'});
    }, 100);
    alert('✅ Đã thêm 1 câu hỏi từ Ngân hàng vào máy tạo đề!');
};

window.deleteGeneratedQuestion = function (qId) {
    if (!confirm('Bạn có chắc muốn xóa câu hỏi này không?')) return;
    const idx = currentExtractedQuestions.findIndex(x => x.id === qId);
    if (idx !== -1) currentExtractedQuestions.splice(idx, 1);
    const el = document.getElementById(`q-item-${qId}`);
    if (el) el.remove();
    // Re-number remaining cards
    const container = document.getElementById('generated-questions-container');
    Array.from(container.querySelectorAll('.question-item strong')).forEach((el, i) => {
        el.textContent = `Câu ${i + 1}`;
    });
};

window.moveQuestionOrder = function (qId, direction) {
    const idx = currentExtractedQuestions.findIndex(x => x.id === qId);
    if (idx === -1) return;
    
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= currentExtractedQuestions.length) return;
    
    // Swap
    const temp = currentExtractedQuestions[idx];
    currentExtractedQuestions[idx] = currentExtractedQuestions[newIdx];
    currentExtractedQuestions[newIdx] = temp;
    
    // Smooth scroll offset recovery
    const yOffset = document.getElementById(`q-item-${qId}`).getBoundingClientRect().top + window.scrollY;
    
    renderGeneratedQuestions();
    
    // Restore pseudo-scroll
    setTimeout(() => {
        window.scrollTo({top: document.getElementById(`q-item-${qId}`).getBoundingClientRect().top + window.scrollY - 150});
    }, 10);
};

let continueAttemptCount = 0;
let isAutoGenerating = false;

document.getElementById('continue-ai-btn')?.addEventListener('click', async () => {
    if (isAutoGenerating) {
        // Nếu đang chạy thì dừng lại
        isAutoGenerating = false;
        document.getElementById('continue-ai-btn').innerHTML = `<i class="fa-solid fa-play"></i> Tạo tiếp (Đã có ${currentExtractedQuestions.length} câu)`;
        document.getElementById('continue-ai-btn').disabled = false;
        return;
    }

    if (currentExtractedQuestions.length === 0) return alert('Chưa có câu hỏi nào để tiếp tục.');

    isAutoGenerating = true;
    const btn = document.getElementById('continue-ai-btn');
    btn.innerHTML = `<i class="fa-solid fa-stop"></i> Dừng lại`;
    btn.style.background = '#dc2626';
    btn.disabled = false; // Giữ enable để người dùng có thể dừng

    const MAX_RETRIES = 12;
    let consecutiveNoNewQ = 0;

    while (isAutoGenerating && continueAttemptCount < MAX_RETRIES) {
        const countBefore = currentExtractedQuestions.length;
        const lastQ = currentExtractedQuestions[currentExtractedQuestions.length - 1];
        continueAttemptCount++;

        btn.innerHTML = `<i class="fa-solid fa-stop"></i> Dừng | Lần ${continueAttemptCount}/${MAX_RETRIES} - Đã có ${countBefore} câu`;

        try {
            const fullText = window.lastExtractedText || '';
            const plainLastQ = lastQ.content ? lastQ.content.replace(/<[^>]+>/g, '').substring(0, 80).trim() : '';
            let startPos = -1;
            if (plainLastQ.length > 20) {
                startPos = fullText.indexOf(plainLastQ.substring(10, 70));
            }
            let partialText = (startPos !== -1) ? fullText.substring(Math.max(0, startPos - 100)) : fullText;

            await callGeminiAPIStreaming(partialText, lastQ.content);
        } catch (err) {
            console.warn('Auto-continue lỗi lần ' + continueAttemptCount + ':', err.message);
        }

        const countAfter = currentExtractedQuestions.length;
        if (countAfter <= countBefore) {
            consecutiveNoNewQ++;
            if (consecutiveNoNewQ >= 2) {
                // 2 lần liên tiếp không ra câu mới → dừng
                break;
            }
        } else {
            consecutiveNoNewQ = 0;
        }

        // Chờ 1 giây để tránh gọi API quá nhanh
        await new Promise(r => setTimeout(r, 1000));
    }

    isAutoGenerating = false;
    btn.style.background = '';
    btn.innerHTML = `<i class="fa-solid fa-play"></i> Tạo tiếp (Đã có ${currentExtractedQuestions.length} câu)`;
    btn.disabled = false;
});

window.switchWizardTab = (tabId) => {
    // Reset buttons
    const tabs = ['settings', 'questions'];
    tabs.forEach(t => {
        const btn = document.getElementById(`tab-${t}-btn`);
        if (btn) {
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-outline');
        }
    });
    // Set active button
    const activeBtn = document.getElementById(`tab-${tabId}-btn`);
    if (activeBtn) {
        activeBtn.classList.remove('btn-outline');
        activeBtn.classList.add('btn-primary');
    }
    
    // Switch content
    document.querySelectorAll('.wizard-tab-content').forEach(el => el.classList.add('hidden'));
    const content = document.getElementById(`wizard-tab-${tabId}`);
    if (content) content.classList.remove('hidden');
};

document.getElementById('save-exam-btn')?.addEventListener('click', async () => {
    // Kiểm tra có câu hỏi nào không trước khi lưu
    if (!currentExtractedQuestions || currentExtractedQuestions.length === 0) {
        alert('⚠️ Chưa có câu hỏi nào để lưu!\nHãy để AI tạo câu hỏi trước hoặc thêm thủ công.');
        return;
    }

    const title = document.getElementById('exam-title').value.trim();
    if (!title) {
        alert('⚠️ Vui lòng nhập tiêu đề cho đề thi!');
        return;
    }
    
    // Sanitize questions
    const cleanQuestions = JSON.parse(JSON.stringify(currentExtractedQuestions)).map(q => {
        delete q.id;
        
        // Sửa triệt để lỗi AI tự sinh câu hỏi Trắc nghiệm nhưng không có 4 đáp án và gán -1 (gây lỗi kết quả)
        if (q.type === 'single' && (!q.options || q.options.length < 2)) {
            q.type = 'short';
            if (q.correctAnswer === -1 || typeof q.correctAnswer === 'number') q.correctAnswer = "";
        }
        
        if (q.correctAnswer === null || q.correctAnswer === undefined || q.correctAnswer === -1 || q.correctAnswer === "-1") {
            if (q.type === 'short') q.correctAnswer = "";
            else if (q.type === 'multiple') q.correctAnswer = [];
            else q.correctAnswer = 0;
        }
        if (q.type !== 'short' && !Array.isArray(q.options)) q.options = [];
        if (!q.content) q.content = "";
        return q;
    });
    
    const description = document.getElementById('exam-description').value.trim();
    const isInfinite = document.getElementById('exam-time-infinite')?.checked;
    const timeLimit = isInfinite ? 0 : (parseInt(document.getElementById('exam-time').value) || 0);
    const examCode = document.getElementById('exam-code').value.trim();
    const status = document.getElementById('exam-status').value;
    const allowRetake = document.getElementById('exam-allow-retake')?.checked !== false; // Default true
    
    const folderId = document.getElementById('exam-folder')?.value || '';
    
    const newExam = {
        title,
        description,
        timeLimit,
        examCode,
        status,
        allowRetake,
        folderId,
        author: state.currentUser.username,
        questions: cleanQuestions,
        createdAt: new Date().toISOString()
    };

    const btn = document.getElementById('save-exam-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';

    try {
        let docId;
        if (state.editingExamId) {
            await firestoreREST.updateDocument('exams', state.editingExamId, newExam);
            docId = state.editingExamId;
            newExam.id = docId;
            const idx = state.exams.findIndex(e => e.id === docId);
            if (idx !== -1) state.exams[idx] = newExam;
            state.editingExamId = null; // Reset for future edits
        } else {
            docId = await firestoreREST.addDocument('exams', newExam);
            newExam.id = docId;
            state.exams.unshift(newExam);
        }
        
        alert('✅ Đã lưu và phát hành đề thi thành công Online!\nHọc sinh ở nhà vẫn có thể làm bài.');
        switchView('teacherDashboard');
        renderTeacherExams();
    } catch (e) {
        console.error('Lỗi lưu đề thi REST:', e);
        alert('Lỗi lưu đề thi: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu và Phát hành Đề thi';
    }
});

// ====== THÊM CÂU HỎI THỦ CÔNG ======
document.getElementById('add-manual-q-btn')?.addEventListener('click', () => {
    const newQ = {
        id: Date.now().toString() + "-manual",
        type: 'single',
        content: 'Câu hỏi mới (nhấn nút chỉnh sửa để thay đổi)',
        options: ['A. Phương án 1', 'B. Phương án 2', 'C. Phương án 3', 'D. Phương án 4'],
        correctAnswer: 0
    };
    currentExtractedQuestions.push(newQ);
    const container = document.getElementById('generated-questions-container');
    const qEl = createQuestionElement(newQ, currentExtractedQuestions.length - 1);
    container.appendChild(qEl);
});

// ====== TEACHER DASHBOARD ======

// Folder data structure stored in localStorage
function getTeacherFolders() {
    try {
        const raw = localStorage.getItem('teacher_folders_' + (state.currentUser?.username || ''));
        return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
}
function saveTeacherFolders(folders) {
    localStorage.setItem('teacher_folders_' + (state.currentUser?.username || ''), JSON.stringify(folders));
}

window.createTeacherFolder = function(parentId) {
    const name = prompt(parentId ? 'Tên thư mục con:' : 'Tên thư mục mới:');
    if (!name || !name.trim()) return;
    const folders = getTeacherFolders();
    folders.push({ id: 'f_' + Date.now(), name: name.trim(), parentId: parentId || '' });
    saveTeacherFolders(folders);
    renderTeacherExams();
};

window.deleteTeacherFolder = function(folderId) {
    if (!confirm('Xóa thư mục này? (Đề thi bên trong sẽ chuyển về Gốc)')) return;
    let folders = getTeacherFolders();
    // Also remove child folders
    const toRemove = new Set();
    function collectChildren(pid) {
        toRemove.add(pid);
        folders.filter(f => f.parentId === pid).forEach(f => collectChildren(f.id));
    }
    collectChildren(folderId);
    folders = folders.filter(f => !toRemove.has(f.id));
    saveTeacherFolders(folders);
    // Move exams from deleted folders back to root (in-memory only, they keep their folderId in Firestore but render in root)
    renderTeacherExams();
};

window.toggleTeacherFolder = function(folderId) {
    const content = document.getElementById('tf-content-' + folderId);
    const toggle = document.getElementById('tf-toggle-' + folderId);
    if (content) {
        content.classList.toggle('open');
        if (toggle) toggle.classList.toggle('open');
    }
};

function populateFolderDropdown() {
    const select = document.getElementById('exam-folder');
    if (!select) return;
    const folders = getTeacherFolders();
    select.innerHTML = '<option value="">📄 Không phân loại (Gốc)</option>';
    function addOptions(parentId, indent) {
        folders.filter(f => f.parentId === (parentId || '')).forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.id;
            opt.textContent = indent + '📁 ' + f.name;
            select.appendChild(opt);
            addOptions(f.id, indent + '\u00a0\u00a0\u00a0\u00a0');
        });
    }
    addOptions('', '');
}

window.renderTeacherExams = function() {
    const list = document.getElementById('teacher-exam-list');
    const myExams = state.exams.filter(e => e.author === state.currentUser.username);
    const folders = getTeacherFolders();
    populateFolderDropdown();

    if (myExams.length === 0 && folders.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted);"><i class="fa-solid fa-folder-open" style="font-size:3rem; margin-bottom:1rem; display:block; opacity:0.3;"></i><p>Bạn chưa tạo đề thi nào. Hãy bắt đầu bằng cách tạo thư mục hoặc đề thi mới!</p></div>`;
        return;
    }

    let html = '<div class="folder-list">';

    function renderFolder(folder, depth) {
        const childFolders = folders.filter(f => f.parentId === folder.id);
        const folderExams = myExams.filter(e => e.folderId === folder.id);
        html += `
            <div class="${depth > 0 ? 'subfolder-card' : 'folder-card'}">
                <div class="${depth > 0 ? 'subfolder-header' : 'folder-header'}" onclick="toggleTeacherFolder('${folder.id}')">
                    <div class="folder-header-left">
                        <div class="folder-icon teacher"><i class="fa-solid fa-folder"></i></div>
                        <div class="folder-info">
                            <h4>${folder.name}</h4>
                            <span>${folderExams.length} đề thi · ${childFolders.length} thư mục con</span>
                        </div>
                    </div>
                    <div style="display:flex; gap:0.5rem; align-items:center;">
                        <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); createTeacherFolder('${folder.id}')" title="Tạo thư mục con"><i class="fa-solid fa-folder-plus"></i></button>
                        <button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); deleteTeacherFolder('${folder.id}')" title="Xóa thư mục"><i class="fa-solid fa-trash" style="color:var(--danger)"></i></button>
                        <i class="fa-solid fa-chevron-down folder-toggle" id="tf-toggle-${folder.id}"></i>
                    </div>
                </div>
                <div class="${depth > 0 ? 'subfolder-content' : 'folder-content'}" id="tf-content-${folder.id}">`;

        // Child folders
        if (childFolders.length > 0) {
            html += '<div class="subfolder-list">';
            childFolders.forEach(cf => renderFolder(cf, depth + 1));
            html += '</div>';
        }
        // Exams in this folder
        folderExams.forEach(e => {
            html += renderTeacherExamItem(e);
        });
        if (childFolders.length === 0 && folderExams.length === 0) {
            html += '<p style="text-align:center; color:var(--text-muted); padding:1rem; font-size:0.85rem;">Thư mục trống</p>';
        }
        html += '</div></div>';
    }

    // Root folders
    folders.filter(f => !f.parentId || f.parentId === '').forEach(f => renderFolder(f, 0));

    // Unfoldered exams
    const validFolderIds = new Set(folders.map(f => f.id));
    const unfolderedExams = myExams.filter(e => !e.folderId || !validFolderIds.has(e.folderId));
    if (unfolderedExams.length > 0) {
        html += '<div style="margin-top:0.5rem;">';
        html += '<p style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.75rem; font-weight:600;"><i class="fa-solid fa-file-lines"></i> Đề thi chưa phân loại</p>';
        html += '<div style="display:flex; flex-direction:column; gap:0.5rem;">';
        unfolderedExams.forEach(e => { html += renderTeacherExamItem(e); });
        html += '</div></div>';
    }

    html += '</div>';
    list.innerHTML = html;
}

function renderTeacherExamItem(e) {
    const draftBadge = e.status === 'draft' ? '<span class="badge" style="background:#f59e0b; color:white; margin-left:0.5rem;"><i class="fa-solid fa-lock"></i> Nháp</span>' : '';
    return `
        <div class="exam-item-inline">
            <div class="exam-item-info">
                <h4>${e.title}${draftBadge}</h4>
                <div class="exam-meta">
                    <span><i class="fa-regular fa-calendar"></i> ${new Date(e.createdAt).toLocaleDateString('vi-VN')}</span>
                    <span><i class="fa-solid fa-list-ol"></i> ${e.questions.length} câu</span>
                    <span><i class="fa-regular fa-clock"></i> ${e.timeLimit ? e.timeLimit + 'p' : '∞'}</span>
                </div>
            </div>
            <div class="exam-item-actions">
                <button class="btn btn-sm btn-outline" onclick="editExam('${e.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="btn btn-sm btn-danger" onclick="deleteExam('${e.id}')" title="Xóa"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
}

window.editExam = (examId) => {
    const exam = state.exams.find(e => e.id === examId);
    if (!exam) return;
    
    // Gán ID đề thi cần sửa để khi bấm Lưu nó sẽ dùng API Update
    state.editingExamId = examId;
    
    // Sửa lỗi variable shadowing (chỉ gán vào biến let thay vì window object)
    currentExtractedQuestions = JSON.parse(JSON.stringify(exam.questions));
    // Tạo lại id UI tạm thời cho các thẻ
    currentExtractedQuestions.forEach((q, i) => q.id = Date.now().toString() + "-" + i);
    
    // Nạp siêu dữ liệu Meta
    document.getElementById('exam-title').value = exam.title || '';
    document.getElementById('exam-description').value = exam.description || '';
    document.getElementById('exam-time').value = exam.timeLimit || 0;
    
    const timeInfiniteCb = document.getElementById('exam-time-infinite');
    if (timeInfiniteCb) {
        timeInfiniteCb.checked = !exam.timeLimit;
        document.getElementById('exam-time').disabled = !exam.timeLimit;
    }
    
    const allowRetakeCb = document.getElementById('exam-allow-retake');
    if (allowRetakeCb) {
        allowRetakeCb.checked = exam.allowRetake !== false;
    }
    
    document.getElementById('exam-code').value = exam.examCode || '';
    document.getElementById('exam-status').value = exam.status || 'published';
    
    // Populate and set folder dropdown
    populateFolderDropdown();
    const folderSelect = document.getElementById('exam-folder');
    if (folderSelect) folderSelect.value = exam.folderId || '';
    
    switchView('examCreation');
    switchWizardTab('settings'); // Mở Tab Setting trước tiên
    document.getElementById('wizard-step-1').classList.add('hidden');
    document.getElementById('wizard-step-2').classList.add('hidden');
    document.getElementById('wizard-step-3').classList.remove('hidden');
    
    renderGeneratedQuestions();
    window.scrollTo(0, 0);
};

window.deleteExam = async (examId) => {
    if (confirm('Bạn có chắc chắn muốn xóa đề thi này trên hệ thống Online không?')) {
        try {
            await firestoreREST.deleteDocument('exams', examId);
            state.exams = state.exams.filter(e => e.id !== examId);
            renderTeacherExams();
        } catch (e) {
            alert('Lỗi xóa đề thi: ' + e.message);
        }
    }
};

// ====== STUDENT DASHBOARD ======
window.renderStudentExams = function() {
    const list = document.getElementById('student-exam-list');
    const publishedExams = state.exams.filter(e => e.status !== 'draft');

    if (publishedExams.length === 0) {
        list.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted);"><i class="fa-solid fa-book-open" style="font-size:3rem; margin-bottom:1rem; display:block; opacity:0.3;"></i><p>Hiện chưa có đề thi nào trên hệ thống.</p></div>`;
        return;
    }

    // Group by teacher (author)
    const teacherMap = {};
    publishedExams.forEach(e => {
        const author = e.author || 'Không rõ';
        if (!teacherMap[author]) teacherMap[author] = [];
        teacherMap[author].push(e);
    });

    let html = '<div class="folder-list" id="student-folder-list">';
    Object.keys(teacherMap).sort().forEach(author => {
        const exams = teacherMap[author];
        html += `
            <div class="folder-card student-teacher-folder" data-teacher="${author.toLowerCase()}">
                <div class="folder-header" onclick="toggleStudentFolder('${author}')">
                    <div class="folder-header-left">
                        <div class="folder-icon student"><i class="fa-solid fa-user-tie"></i></div>
                        <div class="folder-info">
                            <h4>GV: ${author}</h4>
                            <span>${exams.length} đề thi</span>
                        </div>
                    </div>
                    <i class="fa-solid fa-chevron-down folder-toggle" id="sf-toggle-${author}"></i>
                </div>
                <div class="folder-content" id="sf-content-${author}">
                    <div style="display:flex; flex-direction:column; gap:0.5rem;">`;

        exams.forEach(e => {
            const userResults = state.results.filter(r => r.examId === e.id && r.username === state.currentUser.username);
            let actionBtn = `<button class="btn btn-sm btn-primary" onclick="startExam('${e.id}')"><i class="fa-solid fa-play"></i> Làm bài</button>`;
            if (userResults.length > 0) {
                const bestScore = Math.max(...userResults.map(r => r.score));
                if (e.allowRetake !== false) {
                    actionBtn = `<button class="btn btn-sm btn-outline" onclick="startExam('${e.id}')"><i class="fa-solid fa-rotate-right"></i> Làm lại (${bestScore}đ)</button>`;
                } else {
                    actionBtn = `<button class="btn btn-sm btn-outline" disabled><i class="fa-solid fa-check"></i> Đã làm (${bestScore}đ)</button>`;
                }
            }

            html += `
                <div class="exam-item-inline">
                    <div class="exam-item-info">
                        <h4>${e.title}</h4>
                        <div class="exam-meta">
                            <span><i class="fa-solid fa-list-ol"></i> ${e.questions.length} câu</span>
                            <span><i class="fa-regular fa-clock"></i> ${e.timeLimit ? e.timeLimit + 'p' : '∞'}</span>
                        </div>
                    </div>
                    <div class="exam-item-actions">
                        ${actionBtn}
                    </div>
                </div>`;
        });

        html += '</div></div></div>';
    });
    html += '</div>';
    list.innerHTML = html;
};

window.toggleStudentFolder = function(author) {
    const content = document.getElementById('sf-content-' + author);
    const toggle = document.getElementById('sf-toggle-' + author);
    if (content) {
        content.classList.toggle('open');
        if (toggle) toggle.classList.toggle('open');
    }
};

window.filterStudentFolders = function(query) {
    const q = (query || '').toLowerCase().trim();
    document.querySelectorAll('.student-teacher-folder').forEach(folder => {
        const teacher = folder.getAttribute('data-teacher') || '';
        folder.style.display = (!q || teacher.includes(q)) ? '' : 'none';
    });
};

// ====== STUDENT: TAKE EXAM ======
function startExam(examId) {
    const exam = state.exams.find(e => e.id === examId);
    if (!exam) return;

    state.currentTakingExam = exam;
    state.takingExamAnswers = {};

    document.getElementById('take-exam-title').textContent = exam.title;
    const qContainer = document.getElementById('take-exam-questions');
    qContainer.innerHTML = '';

    exam.questions.forEach((q, index) => {
        // Cấp phát lại ID tạm cho phiên làm bài vì dữ liệu trên mảng Firestore đã xóa ID lúc lưu
        if (!q.id) q.id = 'exam_q_' + index;

        const qEl = document.createElement('div');
        qEl.className = 'exam-taking-q';
        qEl.id = `take-q-${q.id}`;

        let inputsHtml = '';
        const rawOptions = Array.isArray(q.options) ? q.options : [];
        if (q.type === 'single') {
            inputsHtml = rawOptions.map((opt, i) => `
                <label class="exam-option-label">
                    <input type="radio" name="q_${q.id}" value="${i}" onchange="saveAnswer('${q.id}', ${i})">
                    <span>${opt}</span>
                </label>
            `).join('');
        } else if (q.type === 'multiple') {
            inputsHtml = rawOptions.map((opt, i) => `
                <label class="exam-option-label">
                    <input type="checkbox" name="q_${q.id}" value="${i}" onchange="saveMultiAnswer('${q.id}', ${i}, this.checked)">
                    <span>${opt}</span>
                </label>
            `).join('');
            state.takingExamAnswers[q.id] = []; // Initialize array for multiple
        } else if (q.type === 'short') {
            inputsHtml = `
                <div class="input-group">
                    <input type="text" placeholder="Nhập câu trả lời của bạn..." onchange="saveShortAnswer('${q.id}', this.value)">
                </div>
            `;
        }

        qEl.innerHTML = `
            <h4>Câu ${index + 1}</h4>
            <div class="q-content mb-4">${q.content}</div>
            ${inputsHtml}
        `;
        // Render công thức toán học LaTeX
        renderMath(qEl);
        qContainer.appendChild(qEl);
    });

    switchView('takeExam');
    
    // Render the grid initially
    renderNavigatorGrid();
    
    // Bật filter all
    filterQuestions('all');

    // Start simple timer mock
    let remainingSeconds = exam.timeLimit ? exam.timeLimit * 60 : 0;
    let elapsedSeconds = 0;
    const isCountdown = exam.timeLimit > 0;
    
    const timerEl = document.getElementById('exam-timer');
    timerEl.style.color = ''; // reset color
    if (isCountdown) {
        const m = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
        const s = (remainingSeconds % 60).toString().padStart(2, '0');
        timerEl.textContent = `${m}:${s}`;
    }

    const timerInterval = setInterval(() => {
        if (!state.currentTakingExam) {
            clearInterval(timerInterval);
            return;
        }

        if (isCountdown) {
            if (remainingSeconds <= 0) {
                clearInterval(timerInterval);
                alert('⏳ Đã hết thời gian làm bài! Hệ thống sẽ tự động nộp bài.');
                document.getElementById('submit-exam-btn').click();
                return;
            }
            remainingSeconds--;
            const m = Math.floor(remainingSeconds / 60).toString().padStart(2, '0');
            const s = (remainingSeconds % 60).toString().padStart(2, '0');
            timerEl.textContent = `${m}:${s}`;
            if (remainingSeconds <= 300) timerEl.style.color = '#dc2626'; // Đỏ nếu dưới 5 phút
        } else {
            elapsedSeconds++;
            const m = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
            const s = (elapsedSeconds % 60).toString().padStart(2, '0');
            timerEl.textContent = `${m}:${s}`;
        }
    }, 1000);

    // Bật tính năng kéo thả Bảng Điều Hướng
    initDraggableSidebar();
}

// Global window functions for inline completely custom events
window.saveAnswer = (qId, optionIndex) => {
    state.takingExamAnswers[qId] = optionIndex;
    renderNavigatorGrid();
};
window.saveMultiAnswer = (qId, optionIndex, isChecked) => {
    if (!state.takingExamAnswers[qId]) state.takingExamAnswers[qId] = [];
    if (isChecked) {
        if (!state.takingExamAnswers[qId].includes(optionIndex)) {
            state.takingExamAnswers[qId].push(optionIndex);
        }
    } else {
        state.takingExamAnswers[qId] = state.takingExamAnswers[qId].filter(x => x !== optionIndex);
    }
    renderNavigatorGrid();
};
window.saveShortAnswer = (qId, text) => {
    state.takingExamAnswers[qId] = text;
    renderNavigatorGrid();
};
window.startExam = startExam;

// Logic Kéo thả Bảng điều hướng
window.initDraggableSidebar = () => {
    const sidebar = document.getElementById('take-exam-sidebar');
    const handle = document.getElementById('nav-drag-handle');
    if (!sidebar || !handle) return;

    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const dragStart = (e) => {
        // Bỏ qua nếu bấm vào nút Collapse/Expand
        if (e.target.closest('span') || e.target.closest('.fa-chevron-down') || e.target.closest('.fa-chevron-up')) {
            return; 
        }
        if (e.type !== 'touchstart') e.preventDefault();
        
        // Đo đạc kích thước & tọa độ tuyệt đối chuẩn xác
        const rect = sidebar.getBoundingClientRect();
        
        if (getComputedStyle(sidebar).position !== 'fixed') {
            sidebar.style.width = rect.width + 'px'; // Force fixed width before float
        }
        
        sidebar.style.position = 'fixed';
        sidebar.style.margin = '0';
        sidebar.style.right = 'auto';
        sidebar.style.bottom = 'auto';
        sidebar.style.zIndex = '99999';
        sidebar.style.transition = 'none'; // Remove lag delays
        
        startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
        startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
        
        initialLeft = rect.left;
        initialTop = rect.top;
        
        // Ngóp giá trị tọa độ thật ngay lập tức
        sidebar.style.left = initialLeft + 'px';
        sidebar.style.top = initialTop + 'px';

        isDragging = true;

        document.addEventListener('mousemove', dragMove, {passive: false});
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('touchmove', dragMove, {passive: false});
        document.addEventListener('touchend', dragEnd);
    };

    const dragMove = (e) => {
        if (!isDragging) return;
        e.preventDefault(); // Chống cuộn nền
        
        const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
        const currentY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
        
        const dx = currentX - startX;
        const dy = currentY - startY;
        
        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;
        
        if (newTop < 0) newTop = 0;
        if (newLeft < 0) newLeft = 0;
        if (newLeft + sidebar.offsetWidth > window.innerWidth) newLeft = window.innerWidth - sidebar.offsetWidth;
        if (newTop + sidebar.offsetHeight > window.innerHeight) newTop = window.innerHeight - sidebar.offsetHeight;

        sidebar.style.left = newLeft + 'px';
        sidebar.style.top = newTop + 'px';
    };

    const dragEnd = () => {
        isDragging = false;
        document.removeEventListener('mousemove', dragMove);
        document.removeEventListener('mouseup', dragEnd);
        document.removeEventListener('touchmove', dragMove);
        document.removeEventListener('touchend', dragEnd);
    };

    handle.addEventListener('mousedown', dragStart);
    handle.addEventListener('touchstart', dragStart, {passive: false});
};

// Các hàm điều hướng Grid UI (Bộ lọc trạng thái)
window.renderNavigatorGrid = () => {
    const grid = document.getElementById('navigator-grid');
    if (!grid) return;
    
    const exam = state.currentTakingExam;
    if (!exam) return;
    
    let doneCount = 0;
    let html = '';
    
    exam.questions.forEach((q, i) => {
        const isDone = state.takingExamAnswers[q.id] && 
            (Array.isArray(state.takingExamAnswers[q.id]) ? state.takingExamAnswers[q.id].length > 0 : String(state.takingExamAnswers[q.id]).trim().length > 0);
        
        if (isDone) doneCount++;
        html += `<div class="nav-square ${isDone ? 'done' : ''}" id="nav-sq-${q.id}" onclick="document.getElementById('take-q-${q.id}').scrollIntoView({behavior: 'smooth', block: 'center'})">${i+1}</div>`;
    });
    
    grid.innerHTML = html;
    document.getElementById('count-done').textContent = doneCount;
    document.getElementById('count-undone').textContent = exam.questions.length - doneCount;
};

window.filterQuestions = (type) => {
    document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));
    const btnId = document.getElementById('filter-' + type);
    if(btnId) btnId.classList.add('active');
    
    const exam = state.currentTakingExam;
    if (!exam) return;
    
    exam.questions.forEach((q, i) => {
        const isDone = state.takingExamAnswers[q.id] && 
            (Array.isArray(state.takingExamAnswers[q.id]) ? state.takingExamAnswers[q.id].length > 0 : String(state.takingExamAnswers[q.id]).trim().length > 0);
            
        const qEl = document.getElementById(`take-q-${q.id}`);
        if (!qEl) return;
        
        if (type === 'all') qEl.classList.remove('question-hidden');
        else if (type === 'done') {
            if (isDone) qEl.classList.remove('question-hidden'); else qEl.classList.add('question-hidden');
        } else if (type === 'undone') {
            if (!isDone) qEl.classList.remove('question-hidden'); else qEl.classList.add('question-hidden');
        }
    });
};

window.filterResult = (type) => {
    const filters = document.querySelectorAll('.result-filters .btn');
    if (!filters || filters.length === 0) return;
    
    filters.forEach(btn => {
        btn.classList.remove('active', 'btn-primary');
        if (!btn.classList.contains('btn-outline')) btn.classList.add('btn-outline');
    });
    
    const activeBtn = document.getElementById('res-filter-' + type);
    if(activeBtn) {
        activeBtn.classList.remove('btn-outline');
        activeBtn.classList.add('btn-primary', 'active');
    }
    
    document.querySelectorAll('.result-q-card').forEach(el => {
        if (type === 'all') el.style.display = 'block';
        else if (type === 'correct') {
            el.style.display = el.classList.contains('result-correct') ? 'block' : 'none';
        }
        else if (type === 'wrong') {
            el.style.display = el.classList.contains('result-incorrect') ? 'block' : 'none';
        }
    });
};

// Submit Exam
document.getElementById('take-exam-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.currentTakingExam) return;

    if (!confirm('Bạn có chắc chắn muốn nộp bài?')) return;

    const submitBtn = document.querySelector('button[form="take-exam-form"]') || document.querySelector('#take-exam-form button[type="submit"]');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Đang nộp bài...';
    }

    try {
        // Auto Grade
        let correctCount = 0;
        const exam = state.currentTakingExam;
        const qCount = exam.questions.length;
        let feedbackHtml = '';

        exam.questions.forEach((q, index) => {
            const userAnswer = state.takingExamAnswers[q.id];
            let isCorrect = false;

            if (userAnswer === undefined || userAnswer === null || String(userAnswer).trim() === '' || (Array.isArray(userAnswer) && userAnswer.length === 0)) {
                isCorrect = false;
            } else {
                if (q.type === 'single') {
                    isCorrect = parseInt(userAnswer) === parseInt(q.correctAnswer);
                } else if (q.type === 'multiple') {
                    if (Array.isArray(userAnswer)) {
                        // Check if arrays contain the same exact elements
                        isCorrect = userAnswer.length === (q.correctAnswer || []).length &&
                            (q.correctAnswer || []).every(val => userAnswer.includes(parseInt(val)));
                    }
                } else if (q.type === 'short') {
                    const normalizedUser = String(userAnswer || '').toLowerCase().trim();
                    const normalizedCorrect = String(q.correctAnswer || '').toLowerCase().trim();
                    isCorrect = normalizedUser === normalizedCorrect;
                }
            }

            if (isCorrect) correctCount++;

            let correctText = String(q.correctAnswer || '');
            let userAnswerText = 'Chưa làm';
            const rawOptions = Array.isArray(q.options) ? q.options : [];
            
            if (q.type === 'single') {
                correctText = rawOptions[parseInt(q.correctAnswer)] || String(q.correctAnswer || '');
                if (userAnswer !== undefined && userAnswer !== null && String(userAnswer).trim() !== '') {
                    userAnswerText = rawOptions[parseInt(userAnswer)] || `Lựa chọn ${userAnswer}`;
                }
            } else if (q.type === 'multiple') {
                correctText = Array.isArray(q.correctAnswer) ? q.correctAnswer.map(i => rawOptions[parseInt(i)] || '').join('<br>') : String(q.correctAnswer || '');
                if (Array.isArray(userAnswer) && userAnswer.length > 0) {
                    userAnswerText = userAnswer.map(i => rawOptions[parseInt(i)] || '').join('<br>');
                }
            } else if (q.type === 'short') {
                if (userAnswer && String(userAnswer).trim() !== '') userAnswerText = String(userAnswer);
            }

            const explanationHtml = q.explanation ? `<div style="margin-top:1.5rem; padding:1.25rem; background:#fef3c7; border-left:4px solid #f59e0b; font-size:0.95rem; border-radius: 4px; box-shadow: inset 0 2px 4px 0 rgba(0,0,0,0.02);"><strong style="color: #b45309;"><i class="fa-solid fa-lightbulb"></i> Lời giải chi tiết:</strong><div style="margin-top:0.75rem; color:#78350f; font-weight: 500;">${q.explanation}</div></div>` : '';

            feedbackHtml += `
                <div class="result-q-card mb-4 p-5 border rounded shadow-sm result-${isCorrect ? 'correct' : 'incorrect'}" style="background-color: white;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 1.5rem;">
                        <strong style="font-size: 1.25rem; color: #1e293b;">Câu ${index + 1}</strong>
                        ${isCorrect ? '<span class="badge" style="background:#22c55e; color:white; padding: 0.5rem 1rem; border-radius: 99px;"><i class="fa-solid fa-check"></i> Chính xác</span>' : '<span class="badge" style="background:#ef4444; color:white; padding: 0.5rem 1rem; border-radius: 99px;"><i class="fa-solid fa-xmark"></i> Sai</span>'}
                    </div>
                    
                    <div class="q-content" style="margin-bottom: 2rem; color: #334155; font-size: 1.1rem; line-height: 1.6; padding-bottom: 1.5rem; border-bottom: 1px dashed #e2e8f0;">
                        ${q.content}
                    </div>
                    
                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; background: #f8fafc; padding: 1.5rem; border-radius: 12px; border: 1px solid #e2e8f0;">
                        <div>
                            <div style="font-size: 0.8rem; color: #64748b; text-transform: uppercase; font-weight: 700; margin-bottom: 0.75rem; letter-spacing: 0.5px;"><i class="fa-solid fa-user-pen"></i> Bài làm của bạn</div>
                            <div style="color: ${isCorrect ? '#15803d' : '#b91c1c'}; font-weight: 600; font-size: 1rem; line-height: 1.5;">
                                ${userAnswerText}
                            </div>
                        </div>
                        <div style="border-left: 2px solid #e2e8f0; padding-left: 1.5rem;">
                            <div style="font-size: 0.8rem; color: #64748b; text-transform: uppercase; font-weight: 700; margin-bottom: 0.75rem; letter-spacing: 0.5px;"><i class="fa-solid fa-circle-check"></i> Đáp án chuẩn</div>
                            <div style="color: #15803d; font-weight: 600; font-size: 1rem; line-height: 1.5;">
                                ${correctText}
                            </div>
                        </div>
                    </div>
                    
                    ${explanationHtml}
                </div>
            `;
        });

        const score = Math.round((correctCount / qCount) * 10);

        const resultObj = {
            examId: exam.id,
            username: state.currentUser.username,
            score: score,
            correctCount,
            totalCount: qCount,
            date: new Date().toISOString()
        };

        const docId = await firestoreREST.addDocument('results', resultObj);
        resultObj.id = docId;
        state.results.push(resultObj);

        document.getElementById('result-score').textContent = `${score}/10`;
        const resCountCorrect = document.getElementById('res-count-correct');
        const resCountWrong = document.getElementById('res-count-wrong');
        if (resCountCorrect) resCountCorrect.textContent = correctCount;
        if (resCountWrong) resCountWrong.textContent = qCount - correctCount;
        document.getElementById('result-feedback').innerHTML = feedbackHtml;
        // Render công thức toán học trong kết quả
        renderMath(document.getElementById('result-feedback'));

        state.currentTakingExam = null;
        switchView('result');

    } catch (err) {
        console.error("Lỗi nội bộ nộp bài:", err);
        alert("Lỗi khi chấm bài/nộp bài: " + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'NỘP BÀI';
        }
    }
});

// ====== INIT ======
document.addEventListener('DOMContentLoaded', () => {
    // onAuthStateChanged sẽ tự động quản lý phiên đăng nhập và giao diện khi khởi tạo Firebase
});
