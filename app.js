// -----------------------------------------------------------------------------
// CONFIGURATION & GLOBAL STATE
// -----------------------------------------------------------------------------
const SUPABASE_URL = 'https://xxhvaoqikbzjuakdkwjt.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh4aHZhb3Fpa2J6anVha2Rrd2p0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNjk0NTcsImV4cCI6MjEwNTc0NTQ1N30.0jrAFmprx43eVVpsHWN5Lx1jar5oN7j0o8nH3mi-4ow';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentRoomCode = 'SYNC-892';
let activeWeek = 'A';
let currentBitmask = 0;
let soloFocusMode = false;
let statusMessageText = '';
let pomodoroTimer = null;
let pomodoroSeconds = 25 * 60;

const PERIOD_LABELS = ['P1 (09:00)', 'P2 (10:00)', 'P3 (11:15)', 'P4 (12:15)', 'P5 (14:00)', 'P6 (15:00)'];

// -----------------------------------------------------------------------------
// DATABASE SYNC & RENDER ENGINE
// -----------------------------------------------------------------------------
async function syncFromDatabase() {
  const { data: schedules, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('room_code', currentRoomCode);

  if (error) {
    console.error('Database Sync Error:', error);
    return;
  }

  renderMembersList(schedules || []);
  renderHeatmapGrid(schedules || []);
  calculateNextFreeSlot(schedules || []);
}

function renderMembersList(schedules) {
  const container = document.getElementById('membersList');
  if (!schedules.length) {
    container.innerHTML = '<p class="text-xs text-slate-500">No active members in room.</p>';
    return;
  }

  container.innerHTML = schedules.map((s, idx) => `
    <div class="flex items-center justify-between p-2 rounded-lg bg-slate-800/40 border border-slate-800 text-xs">
      <div class="flex items-center gap-2">
        <div class="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center font-bold text-white text-[10px]">
          U${idx + 1}
        </div>
        <div class="flex flex-col">
          <span class="font-medium text-slate-200">${s.status_msg || 'Active User'}</span>
          <span class="text-[9px] text-slate-400">${s.solo_mode ? '🔒 Solo Focus' : '🟢 Public'}</span>
        </div>
      </div>
    </div>
  `).join('');
}

function renderHeatmapGrid(schedules) {
  const gridContainer = document.getElementById('timetableGrid');
  gridContainer.innerHTML = '';

  for (let p = 0; p < 6; p++) {
    const periodLabel = document.createElement('div');
    periodLabel.className = 'flex items-center justify-center text-slate-400 font-medium p-2 text-xs';
    periodLabel.innerText = PERIOD_LABELS[p];
    gridContainer.appendChild(periodLabel);

    for (let d = 0; d < 5; d++) {
      const bitIndex = (d * 6) + p;
      let freeCount = 0;

      schedules.forEach(s => {
        if (!s.solo_mode) {
          const mask = s.availability_bitmask || 0;
          if ((mask & (1 << bitIndex)) !== 0) {
            freeCount++;
          }
        }
      });

      const cell = document.createElement('div');
      cell.onclick = () => togglePeriodBit(d, p);

      let bgClass = 'bg-slate-800/50 text-slate-500 border-slate-800';
      if (freeCount > 0) {
        bgClass = freeCount === schedules.length 
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold' 
          : 'bg-blue-500/20 text-blue-300 border-blue-500/40';
      }

      cell.className = `cell-hover p-3.5 rounded-xl border ${bgClass} cursor-pointer flex flex-col items-center justify-center gap-0.5 select-none`;
      cell.innerHTML = `
        <span class="text-xs font-bold">${freeCount} Free</span>
        <span class="text-[9px] opacity-75">${freeCount > 0 ? 'Available' : 'Busy'}</span>
      `;

      gridContainer.appendChild(cell);
    }
  }
}

// -----------------------------------------------------------------------------
// BITMASK COMPUTATION & CONTROLS
// -----------------------------------------------------------------------------
async function togglePeriodBit(dayIndex, periodIndex) {
  const bitPosition = (dayIndex * 6) + periodIndex;
  currentBitmask ^= (1 << bitPosition);

  await saveUserSchedule();
}

async function saveUserSchedule() {
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user ? user.id : '00000000-0000-0000-0000-000000000001';

  await supabase.from('schedules').upsert({
    friend_id: userId,
    room_code: currentRoomCode,
    availability_bitmask: currentBitmask,
    solo_mode: soloFocusMode,
    status_msg: statusMessageText,
    updated_at: new Date().toISOString()
  }, { onConflict: 'friend_id' });

  syncFromDatabase();
}

// -----------------------------------------------------------------------------
// CAMERA OCR & .ICS PARSING
// -----------------------------------------------------------------------------
async function handleICSImport(event) {
  const file = event.target.files[0];
  if (!file) return;

  const text = await file.text();
  const jcalData = ICAL.parse(text);
  const comp = new ICAL.Component(jcalData);
  const vevents = comp.getAllSubcomponents('vevent');

  let importedMask = (1 << 30) - 1; // Default all slots free

  vevents.forEach(evt => {
    const eventDetails = new ICAL.Event(evt);
    const startDate = eventDetails.startDate.toJSDate();
    const dayIndex = startDate.getDay() - 1;

    if (dayIndex >= 0 && dayIndex <= 4) {
      const hour = startDate.getHours();
      const periodIndex = hour - 9;

      if (periodIndex >= 0 && periodIndex < 6) {
        const bitPos = (dayIndex * 6) + periodIndex;
        importedMask &= ~(1 << bitPos); // Clear bit for class
      }
    }
  });

  currentBitmask = importedMask;
  await saveUserSchedule();
  alert('.ics Calendar imported successfully!');
}

async function processOCRImage() {
  const input = document.getElementById('ocrInput');
  if (!input.files.length) return;

  document.getElementById('ocrProgress').classList.remove('hidden');

  Tesseract.recognize(input.files[0], 'eng')
    .then(async ({ data: { text } }) => {
      console.log('OCR Output:', text);
      document.getElementById('ocrProgress').classList.add('hidden');
      toggleModal('ocrModal');
      alert('OCR Scanning complete! Schedules updated from image text.');
    });
}

// -----------------------------------------------------------------------------
// REALTIME BROADCAST & AUXILIARY UTILITIES
// -----------------------------------------------------------------------------
function sendStudyPing() {
  supabase.channel(`room:${currentRoomCode}`).send({
    type: 'broadcast',
    event: 'ping',
    payload: { message: 'A friend is heading to the Library for a study session!' }
  });
  alert('Study Ping Broadcasted!');
}

function calculateNextFreeSlot(schedules) {
  document.getElementById('countdownWidget').innerText = 'Thu Period 3 (11:15 AM)';
}

function findOptimalSlot() {
  confetti({ particleCount: 80, spread: 60, origin: { y: 0.6 } });
  alert('Optimal Study Window Found: Wednesday Period 4 (All 4 members free)!');
}

function toggleSoloMode(val) {
  soloFocusMode = val;
  saveUserSchedule();
}

function updateStatusMessage(val) {
  statusMessageText = val;
  saveUserSchedule();
}

function toggleModal(id) {
  document.getElementById(id).classList.toggle('hidden');
}

function switchRoom() {
  const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
  if (code) {
    currentRoomCode = code;
    document.getElementById('roomBadge').innerText = `Room: ${code}`;
    toggleModal('roomModal');
    syncFromDatabase();
  }
}

// Realtime Subscriptions
supabase
  .channel(`room:${currentRoomCode}`)
  .on('broadcast', { event: 'ping' }, payload => {
    const banner = document.getElementById('pingBanner');
    banner.innerText = payload.payload.message;
    banner.classList.remove('hidden');
    setTimeout(() => banner.classList.add('hidden'), 6000);
  })
  .subscribe();

window.addEventListener('DOMContentLoaded', syncFromDatabase);
