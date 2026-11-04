// ==========================================
// 1. 在这里填入你的 Supabase 配置
// ==========================================
const SUPABASE_URL = 'https://qaffdlewwsfzgoruhjho.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bLoMgVcw3cv7hO8bJyVplA_O_ESlK6j';

const { createClient } = supabase;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// 2. 全局变量与状态
// ==========================================
const defaultCategories = [
    { name: 'A', budget: 0 }, { name: 'B', budget: 0 },
    { name: 'C', budget: 0 }, { name: '其他', budget: 0 }
];

let currentMonth = ""; 
let appData = {}; 
let monthList = []; 
let currentUser = null; // 保存当前登录的用户
let syncTimeout = null; // 防抖定时器
let isAuthModalLoginMode = true; // 悬浮窗状态：默认登录模式

// ==========================================
// 3. 初始化与监听
// ==========================================
async function init() {
    // 读取本地数据 (无论登不登录，本地先加载)
    const savedData = localStorage.getItem('myLedgerData');
    if (savedData) {
        try { appData = JSON.parse(savedData); } catch (e) { appData = {}; }
    }
    
    // 监听 Supabase 登录状态变化
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (session) {
            currentUser = session.user;
            updateUserStatusUI(true);
            
            // 【修改这里】只有当用户实际登录（或刚打开页面读取到登录态）时，才执行同步
            // 忽略 TOKEN_REFRESHED（后台自动续签），防止频繁弹窗和合并
            if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                await pullDataFromCloud();
            }
        } else {
            currentUser = null;
            updateUserStatusUI(false);
        }
    });

    initDateSelectors();
    document.getElementById('inputDate').valueAsDate = new Date();
    document.getElementById('inputIncomeDate').valueAsDate = new Date();
    rebuildMonthList();
    setToCurrentDate();
    loadMonthData();
}

// ==========================================
// 4. 认证与登录/注册弹窗逻辑
// ==========================================
function toggleAuthModal() {
    const modal = document.getElementById('authModal');
    if (currentUser) {
        // 如果已登录，点击则是退出
        if(confirm("您已登录，是否要退出账号？\n(退出后恢复本地模式)")) {
            supabaseClient.auth.signOut();
        }
        return;
    }
    modal.classList.toggle('active');
    document.getElementById('authError').innerText = '';
}

function switchAuthMode() {
    isAuthModalLoginMode = !isAuthModalLoginMode;
    document.getElementById('modalTitle').innerText = isAuthModalLoginMode ? '登录云端账号' : '注册新账号';
    document.getElementById('authSubmitBtn').innerText = isAuthModalLoginMode ? '登 录' : '注 册';
    document.getElementById('switchText').innerText = isAuthModalLoginMode ? '还没有账号？' : '已有账号？';
    document.getElementById('switchBtn').innerText = isAuthModalLoginMode ? '去注册' : '去登录';
    document.getElementById('authError').innerText = '';
}

async function handleAuthSubmit() {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const errorEl = document.getElementById('authError');
    
    if (!email || !password) {
        errorEl.innerText = "请填写邮箱和密码！";
        return;
    }

    const btn = document.getElementById('authSubmitBtn');
    btn.innerText = "处理中...";
    btn.disabled = true;

    try {
        if (isAuthModalLoginMode) {
            const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (error) throw error;
        } else {
            const { error } = await supabaseClient.auth.signUp({ email, password });
            if (error) throw error;
            alert("注册成功！如开启了邮箱验证请前往邮箱查收。现在尝试为您登录...");
            // 注册后自动尝试登录
            await supabaseClient.auth.signInWithPassword({ email, password });
        }
        // 成功后关闭弹窗并清空
        document.getElementById('authModal').classList.remove('active');
        document.getElementById('authEmail').value = '';
        document.getElementById('authPassword').value = '';
    } catch (err) {
        errorEl.innerText = err.message || "操作失败，请检查网络或账号密码";
    } finally {
        btn.innerText = isAuthModalLoginMode ? '登 录' : '注 册';
        btn.disabled = false;
    }
}

function updateUserStatusUI(isLoggedIn) {
    const statusEl = document.getElementById('userStatus');
    if (isLoggedIn) {
        statusEl.classList.add('logged-in');
        // 只显示邮箱前缀
        const displayEmail = currentUser.email.split('@')[0];
        statusEl.innerHTML = `<span class="status-dot"></span> ${displayEmail} (云端同步中)`;
    } else {
        statusEl.classList.remove('logged-in');
        statusEl.innerHTML = `<span class="status-dot"></span> 未登录 (本地模式)`;
    }
}

// ==========================================
// 5. 云端数据交互核心逻辑
// ==========================================
// ==========================================
// 新增：核心数据合并函数
// ==========================================
function mergeData(localData, cloudData) {
    const merged = {};
    // 1. 获取所有存在的月份并去重
    const allMonths = new Set([...Object.keys(localData), ...Object.keys(cloudData)]);

    allMonths.forEach(month => {
        const localMonth = localData[month] || { categories: [], records: [], incomeRecords: [] };
        const cloudMonth = cloudData[month] || { categories: [], records: [], incomeRecords: [] };

        // 2. 合并支出明细 (以记录 id 去重)
        const recordMap = new Map();
        [...cloudMonth.records, ...localMonth.records].forEach(r => recordMap.set(r.id, r));
        const mergedRecords = Array.from(recordMap.values());

        // 3. 合并收入明细 (以记录 id 去重)
        const incomeMap = new Map();
        [...(cloudMonth.incomeRecords || []), ...(localMonth.incomeRecords || [])].forEach(r => incomeMap.set(r.id, r));
        const mergedIncomeRecords = Array.from(incomeMap.values());

        // 4. 合并预算分类 (以分类 name 去重)
        const categoryMap = new Map();
        // 先放云端的
        (cloudMonth.categories || []).forEach(c => categoryMap.set(c.name, c));
        // 再放本地的 (名字相同时，本地的预算配置会覆盖云端的)
        (localMonth.categories || []).forEach(c => categoryMap.set(c.name, c));
        const mergedCategories = Array.from(categoryMap.values());

        // 5. 组装该月数据
        merged[month] = {
            income: localMonth.income || cloudMonth.income || 0,
            rollover: 0, // 稍后由 recalculateRollovers 重新计算
            categories: mergedCategories,
            records: mergedRecords,
            incomeRecords: mergedIncomeRecords
        };
    });

    return merged;
}
// ==========================================
// 修改：登录后拉取/合并云端数据
// ==========================================
async function pullDataFromCloud() {
    if (!currentUser) return;
    
    try {
        const { data, error } = await supabaseClient
            .from('ledgers')
            .select('data')
            .eq('user_id', currentUser.id)
            .single();

        if (error && error.code !== 'PGRST116') { // 忽略没找到记录的错误
            throw error;
        }

        // 情况 A：云端有数据
        if (data && data.data) {
            const cloudData = data.data;
            const hasLocalData = Object.keys(appData).length > 0;
            
            if (hasLocalData) {
                // 【核心改进】直接静默合并，不再询问覆盖！
                appData = mergeData(appData, cloudData);
                saveLocalOnly();
                
                // 重新构建月份列表并计算结转
                rebuildMonthList();  
                recalculateRollovers(); 
                loadMonthData(); // 刷新界面
                
                // 将合并后的结果推送到云端
                await pushDataToCloud(true); 
                
            } else {
                // 本地空白，直接使用云端数据
                appData = cloudData;
                saveLocalOnly();
                rebuildMonthList();
                recalculateRollovers();
                loadMonthData();
            }
        } 
        // 情况 B：云端无数据（新用户首次登录）
        else {
            // 如果本地有记录，自动推上去
            if (Object.keys(appData).length > 0) {
                rebuildMonthList();
                recalculateRollovers();
                await pushDataToCloud(true);
            }
        }
        
    } catch (err) {
        console.error("拉取云端数据失败:", err);
        alert("同步云端数据失败，请检查网络。已恢复至本地模式显示。");
    }
}

// 防抖推送：防止打字太快疯狂发请求
function syncToCloudDebounced() {
    if (!currentUser) return;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        pushDataToCloud();
    }, 2000); // 停止输入 2 秒后触发同步
}

async function pushDataToCloud(isForce = false) {
    if (!currentUser) return;
    
    try {
        const { error } = await supabaseClient
            .from('ledgers')
            .upsert({ 
                user_id: currentUser.id, 
                data: appData,
                updated_at: new Date()
            }, { onConflict: 'user_id' });

        if (error) throw error;
        
        // 如果是首次强同步，给右上角状态栏一个短暂的视觉反馈
        if (isForce) {
            const statusEl = document.getElementById('userStatus');
            const originalText = statusEl.innerHTML;
            statusEl.innerHTML = `<span class="status-dot"></span> 已同步至云端 ✅`;
            setTimeout(() => { statusEl.innerHTML = originalText; }, 2000);
        }
        
    } catch (err) {
        console.error("云端同步失败:", err);
        alert("❌ 云端同步失败: " + (err.message || JSON.stringify(err)));
    }
}

// ==========================================
// 6. 本地数据保存逻辑 (修改原有的 saveData)
// ==========================================
function saveLocalOnly() {
    localStorage.setItem('myLedgerData', JSON.stringify(appData));
}

// 所有的保存操作都会调用这里
function saveData() {
    saveLocalOnly(); // 1. 绝对先保存到本地（防断网、防丢）
    
    // 2. 如果已登录，触发防抖云端同步
    if (currentUser) {
        syncToCloudDebounced();
    }
}

// ==========================================
// 7. 原有 UI 渲染逻辑 (保持不变，除个别函数调用了 updateBudgetTags)
// ==========================================
function initDateSelectors() {
    const yearSelect = document.getElementById('yearSelect');
    const monthSelect = document.getElementById('monthSelect');
    yearSelect.innerHTML = '';
    monthSelect.innerHTML = '';

    let existingYears = new Set();
    for (let key in appData) {
        const match = key.match(/^(\d{4})年/);
        if (match) existingYears.add(parseInt(match[1]));
    }
    const currentYear = new Date().getFullYear();
    for (let i = -5; i <= 5; i++) existingYears.add(currentYear + i);

    const sortedYears = Array.from(existingYears).sort((a, b) => b - a);
    sortedYears.forEach(year => {
        const option = document.createElement('option');
        option.value = year; option.text = year;
        yearSelect.appendChild(option);
    });

    for (let i = 1; i <= 12; i++) {
        const option = document.createElement('option');
        option.value = i; option.text = i;
        monthSelect.appendChild(option);
    }
}

function setToCurrentDate() {
    const today = new Date();
    document.getElementById('yearSelect').value = today.getFullYear();
    document.getElementById('monthSelect').value = today.getMonth() + 1;
}

function rebuildMonthList() {
    monthList = [];
    let years = [];
    for (let key in appData) {
        const match = key.match(/^(\d{4})年/);
        if (match) years.push(parseInt(match[1]));
    }
    const currentYear = new Date().getFullYear();
    years.push(currentYear); 
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years) + 1; 

    for (let y = minYear; y <= maxYear; y++) {
        for (let m = 1; m <= 12; m++) {
            monthList.push(`${y}年${m}月`);
        }
    }
}

function loadMonthData() {
    const year = document.getElementById('yearSelect').value;
    const month = document.getElementById('monthSelect').value;
    if (!year || !month) return; 
    currentMonth = `${year}年${month}月`;

    if (!appData[currentMonth]) {
        appData[currentMonth] = createNewMonthData();
        saveData(); // 这里会自动触发本地存和云端同步
    }
    if (!appData[currentMonth].incomeRecords) appData[currentMonth].incomeRecords = [];

    recalculateRollovers();
    const monthData = appData[currentMonth];
    
    document.getElementById('totalIncome').value = calculateMonthIncome(monthData) || '0';
    document.getElementById('lastMonthRollover').innerText = monthData.rollover || 0;

    renderIncomeRecords();       
    renderBudgetTable();
    renderRecords();
    updateViewAndChart();
}

function createNewMonthData() {
    let currentExpenseCats = JSON.parse(JSON.stringify(defaultCategories));
    const monthsArray = Object.keys(appData).sort(); 
    if (monthsArray.length > 0) {
        const lastMonthData = appData[monthsArray[monthsArray.length - 1]];
        if (lastMonthData && lastMonthData.categories) {
            currentExpenseCats = JSON.parse(JSON.stringify(lastMonthData.categories));
        }
    }
    return { income: 0, rollover: 0, categories: currentExpenseCats, records: [], incomeRecords: [] };
}

function recalculateRollovers() {
    let prevNet = 0; 
    monthList.forEach((month) => {
        if (!appData[month]) appData[month] = createNewMonthData();
        if (appData[month]) {
            appData[month].rollover = prevNet;
            prevNet = calculateMonthNet(appData[month]);
        }
    });
}

function calculateMonthIncome(monthData) {
    if (!monthData.incomeRecords) return 0;
    return monthData.incomeRecords.reduce((sum, record) => sum + Number(record.amount), 0);
}

function calculateMonthExpense(monthData) {
    return monthData.records.reduce((sum, record) => sum + Number(record.amount), 0);
}

function calculateMonthNet(monthData) {
    const income = calculateMonthIncome(monthData); 
    const rollover = Number(monthData.rollover) || 0;
    const expense = calculateMonthExpense(monthData);
    return income + rollover - expense;
}

function updateBudgetTags() {
    const monthData = appData[currentMonth];
    if (!monthData || !monthData.categories) return;

    let totalBudget = 0;
    let totalExpense = 0;

    monthData.categories.forEach(cat => {
        totalBudget += (Number(cat.budget) || 0);
        totalExpense += monthData.records
            .filter(r => r.category === cat.name)
            .reduce((sum, r) => sum + Number(r.amount), 0);
    });

    const totalRemain = totalBudget - totalExpense;
    document.getElementById('totalBudgetDisplay').innerText = `总预算: ${totalBudget}`;
    
    const remainEl = document.getElementById('totalRemainDisplay');
    remainEl.innerText = `总剩余: ${totalRemain}`;
    
    if (totalRemain < 0) {
        remainEl.style.color = '#ff4757';
        remainEl.style.backgroundColor = '#fff2f2';
    } else {
        remainEl.style.color = '#2ed573';
        remainEl.style.backgroundColor = '#f0fbf4';
    }
}

function updateCategoryBudget(index, newBudget) {
    appData[currentMonth].categories[index].budget = Number(newBudget) || 0;
    updateBudgetTags(); 
    updateOverviewOnly();
    
    const monthData = appData[currentMonth];
    const cat = monthData.categories[index];
    const catExpense = monthData.records.filter(r => r.category === cat.name).reduce((sum, r) => sum + Number(r.amount), 0);
    const remaining = cat.budget - catExpense;
    
    const tr = document.querySelectorAll('#budgetBody tr')[index];
    if (tr) {
        const remainingTd = tr.children[3];
        remainingTd.innerText = remaining;
        remainingTd.className = remaining < 0 ? 'highlight' : '';
    }
    saveData();
}

function updateOverviewOnly() {
    const monthData = appData[currentMonth];
    const totalIncome = calculateMonthIncome(monthData);
    const totalExpense = calculateMonthExpense(monthData);
    recalculateRollovers(); 
    const netIncome = calculateMonthNet(monthData);

    document.getElementById('totalIncome').value = totalIncome || '0';
    document.getElementById('totalExpense').innerText = totalExpense;
    document.getElementById('netIncome').innerText = netIncome;
    document.getElementById('lastMonthRollover').innerText = monthData.rollover || 0;
}

function exportData() {
    if (Object.keys(appData).length === 0) return alert("目前没有任何数据可以导出！");
    const dataStr = JSON.stringify(appData, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const date = new Date();
    const dateStr = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = `记账本备份_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            if (typeof importedData !== 'object' || Array.isArray(importedData)) throw new Error("数据格式不正确");
            if (confirm("⚠️ 导入备份将覆盖当前所有数据！\n\n确定要导入吗？建议先导出当前数据作为保险。")) {
                appData = importedData;
                saveData(); // 自动同步
                initDateSelectors();
                rebuildMonthList();
                setToCurrentDate();
                loadMonthData();
                alert("✅ 数据导入成功！");
            }
        } catch (err) {
            alert("❌ 导入失败，文件可能已损坏或不是合法的备份文件。\n\n错误信息：" + err.message);
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}

function addIncomeRecord() {
    const categoryInput = document.getElementById('inputIncomeCategory');
    const date = document.getElementById('inputIncomeDate').value;
    const amount = Number(document.getElementById('inputIncomeAmount').value);
    const note = document.getElementById('inputIncomeNote').value;
    const category = categoryInput.value.trim();

    if (!category) return alert("请输入收入类别（如：工资）！");
    if (!date || !amount || amount <= 0) return alert("请填写完整的日期和正确的金额！");

    appData[currentMonth].incomeRecords.push({
        id: 'inc_' + Date.now().toString(), category, date, amount, note
    });
    
    categoryInput.value = '';
    document.getElementById('inputIncomeAmount').value = '';
    document.getElementById('inputIncomeNote').value = '';
    categoryInput.focus();

    calculateAll(); 
}

function deleteIncomeRecord(id) {
    if (!confirm("确定要删除这条收入记录吗？")) return;
    appData[currentMonth].incomeRecords = appData[currentMonth].incomeRecords.filter(r => r.id !== id);
    calculateAll();
}

function renderIncomeRecords() {
    const tbody = document.getElementById('incomeRecordBody');
    tbody.innerHTML = '';
    const sortedRecords = [...appData[currentMonth].incomeRecords].reverse();

    if (sortedRecords.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#999; padding: 20px 0;">暂无收入记录</td></tr>';
        return;
    }
    sortedRecords.forEach(record => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${record.category}</td>
            <td>${record.date.substring(5)}</td>
            <td style="color: #2ed573; font-weight: bold;">+${record.amount}</td>
            <td>${record.note || '-'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteIncomeRecord('${record.id}')">删</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function addCategory() {
    const newName = prompt("请输入新的支出分类名称：");
    if (!newName || newName.trim() === "") return;
    const monthData = appData[currentMonth];
    if (monthData.categories.some(c => c.name === newName.trim())) return alert("该分类已存在！");
    monthData.categories.push({ name: newName.trim(), budget: 0 });
    calculateAll();
}

function deleteCategory(index) {
    const monthData = appData[currentMonth];
    const catName = monthData.categories[index].name;
    const hasRecords = monthData.records.some(r => r.category === catName);
    if (hasRecords) {
        if (!confirm(`分类“${catName}”下已有记账明细，删除后不影响总账。确定删除吗？`)) return;
    } else {
        if (!confirm(`确定要删除分类“${catName}”吗？`)) return;
    }
    monthData.categories.splice(index, 1);
    calculateAll();
}

function renderBudgetTable() {
    const monthData = appData[currentMonth];
    const tbody = document.getElementById('budgetBody');
    tbody.innerHTML = '';

    const inputCategory = document.getElementById('inputCategory');
    const filterCategory = document.getElementById('filterCategory');
    const currentInputVal = inputCategory.value;
    const currentFilterVal = filterCategory.value;

    inputCategory.innerHTML = '';
    filterCategory.innerHTML = '<option value="全部">全部明细</option>';

    monthData.categories.forEach((cat, index) => {
        const catExpense = monthData.records.filter(r => r.category === cat.name).reduce((sum, r) => sum + Number(r.amount), 0);
        const remaining = cat.budget - catExpense;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="text" value="${cat.name}" onchange="updateCategoryName(${index}, this.value)"></td>
            <td><input type="number" value="${cat.budget}" oninput="updateCategoryBudget(${index}, this.value)"></td>
            <td>${catExpense}</td>
            <td class="${remaining < 0 ? 'highlight' : ''}">${remaining}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteCategory(${index})">删</button></td>
        `;
        tbody.appendChild(tr);

        const option1 = document.createElement('option');
        option1.value = cat.name; option1.text = cat.name;
        inputCategory.appendChild(option1);

        const option2 = document.createElement('option');
        option2.value = cat.name; option2.text = cat.name;
        filterCategory.appendChild(option2);
    });

    if (currentInputVal && monthData.categories.some(c => c.name === currentInputVal)) inputCategory.value = currentInputVal;
    if (currentFilterVal) filterCategory.value = currentFilterVal;

    updateBudgetTags();
}

function renderRecords() {
    const monthData = appData[currentMonth];
    const tbody = document.getElementById('recordBody');
    const filterVal = document.getElementById('filterCategory').value;
    tbody.innerHTML = '';

    let recordsToShow = monthData.records;
    if (filterVal !== '全部') recordsToShow = monthData.records.filter(r => r.category === filterVal);
    const sortedRecords = [...recordsToShow].reverse();

    if (sortedRecords.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#999; padding: 20px 0;">暂无明细记录</td></tr>';
        return;
    }
    sortedRecords.forEach(record => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${record.category}</td>
            <td>${record.date.substring(5)}</td>
            <td class="highlight">${record.amount}</td>
            <td>${record.note || '-'}</td>
            <td><button class="btn btn-danger btn-sm" onclick="deleteRecord('${record.id}')">删</button></td>
        `;
        tbody.appendChild(tr);
    });
}

function calculateAll() {
    rebuildMonthList();  
    initDateSelectors(); 
    const match = currentMonth.match(/^(\d{4})年(\d{1,2})月/);
    if(match) {
        document.getElementById('yearSelect').value = match[1];
        document.getElementById('monthSelect').value = match[2];
    }
    recalculateRollovers(); 
    updateViewAndChart();
    renderIncomeRecords();
    renderBudgetTable(); 
    renderRecords();     
    saveData();
}

function updateCategoryName(index, newName) {
    if (!newName || newName.trim() === '') {
        alert("分类名称不能为空！");
        renderBudgetTable(); 
        return;
    }
    const monthData = appData[currentMonth];
    const oldName = monthData.categories[index].name;
    if (oldName !== newName.trim() && monthData.categories.some(c => c.name === newName.trim())) {
        alert("该分类名称已存在！");
        renderBudgetTable();
        return;
    }
    monthData.categories[index].name = newName.trim();
    monthData.records.forEach(r => { if (r.category === oldName) r.category = newName.trim(); });
    calculateAll();
}

function addRecord() {
    const category = document.getElementById('inputCategory').value;
    const date = document.getElementById('inputDate').value;
    const amount = Number(document.getElementById('inputAmount').value);
    const note = document.getElementById('inputNote').value;

    if (!date || !amount || amount <= 0) return alert("请填写完整的日期和正确的金额！");
    appData[currentMonth].records.push({
        id: Date.now().toString(), category, date, amount, note
    });
    document.getElementById('inputAmount').value = '';
    document.getElementById('inputNote').value = '';
    calculateAll(); 
}

function deleteRecord(id) {
    if (!confirm("确定要删除这条记录吗？")) return;
    appData[currentMonth].records = appData[currentMonth].records.filter(r => r.id !== id);
    calculateAll();
}

let myChart = null;
function updateViewAndChart() {
    const monthData = appData[currentMonth];
    const totalIncome = calculateMonthIncome(monthData);
    const totalExpense = calculateMonthExpense(monthData);
    const netIncome = calculateMonthNet(monthData);

    document.getElementById('totalIncome').value = totalIncome || '0';
    document.getElementById('totalExpense').innerText = totalExpense;
    document.getElementById('netIncome').innerText = netIncome;
    document.getElementById('lastMonthRollover').innerText = monthData.rollover || 0;

    updateChart(monthData);
}

function updateChart(monthData) {
    if (!myChart) myChart = echarts.init(document.getElementById('chart'));
    const chartData = [];
    monthData.categories.forEach(cat => {
        const catExpense = monthData.records.filter(r => r.category === cat.name).reduce((sum, r) => sum + Number(r.amount), 0);
        if (catExpense > 0) chartData.push({ name: cat.name, value: catExpense });
    });

    myChart.setOption({
        tooltip: { trigger: 'item' },
        legend: { top: 'bottom', type: 'scroll' },
        series: [{
            name: '支出金额', type: 'pie', radius: ['40%', '70%'],
            itemStyle: { borderRadius: 10, borderColor: '#fff', borderWidth: 2 },
            label: { show: false, position: 'center' },
            emphasis: { label: { show: true, fontSize: 16, fontWeight: 'bold' } },
            labelLine: { show: false },
            data: chartData
        }]
    }, true); 
}

window.onload = init;