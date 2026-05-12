import { useCallback, useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ─────────────────────────────────────────────────────────
//  STATE ENUM — 7 states matching firmware + dashboard logic
// ─────────────────────────────────────────────────────────
const S = {
  DISC: "DISCONNECTED",
  ZERO: "ZERO_CAL",
  IDLE: "IDLE",
  ARM: "ARMING",
  READY: "READY",
  RUN: "RUNNING",
  FAIL: "FAILSAFE",
};

const THEME = {
  page: "#f5f7fb",
  panel: "#ffffff",
  panelSoft: "#f8fafc",
  card: "#ffffff",
  border: "#d9e2ec",
  borderStrong: "#b9c7d6",
  text: "#152238",
  muted: "#6b7a90",
  faint: "#9aa8b7",
  grid: "#e6edf5",
  input: "#ffffff",
  console: "#f8fafc",
  shadow: "0 10px 28px rgba(15, 35, 65, 0.08)",
};

const SM = {
  [S.DISC]: {
    label: "DISCONNECTED",
    desc: "No serial connection",
    bg: "#edf2f7",
    border: "#9aa8b7",
    text: "#607086",
    accent: "#64748b",
  },
  [S.ZERO]: {
    label: "ZERO CAL",
    desc: "Calibrating current baseline (3 s)…",
    bg: "#fff7df",
    border: "#d89b12",
    text: "#8a5a00",
    accent: "#f2a900",
  },
  [S.IDLE]: {
    label: "IDLE",
    desc: "Connected · motor NOT armed",
    bg: "#e9f2ff",
    border: "#4d83c7",
    text: "#245587",
    accent: "#2d6fb3",
  },
  [S.ARM]: {
    label: "ARMING",
    desc: "2 s arm delay · commands BLOCKED",
    bg: "#fff7df",
    border: "#d89b12",
    text: "#8a5a00",
    accent: "#f2a900",
  },
  [S.READY]: {
    label: "READY",
    desc: "Motor armed · MIN throttle (1000 µs)",
    bg: "#e7f3ff",
    border: "#1684cf",
    text: "#07598f",
    accent: "#0c88d8",
  },
  [S.RUN]: {
    label: "RUNNING",
    desc: "Motor active · data streaming",
    bg: "#ecf9e8",
    border: "#38a138",
    text: "#21721f",
    accent: "#2e9e2e",
  },
  [S.FAIL]: {
    label: "FAILSAFE",
    desc: "30 s timeout · motor killed",
    bg: "#fff0f0",
    border: "#d64545",
    text: "#a42626",
    accent: "#df3c3c",
  },
};

const NS = {
  [S.DISC]: { fill: "#eef2f7", stroke: "#94a3b8", text: "#475569" },
  [S.ZERO]: { fill: "#fff2c6", stroke: "#c98500", text: "#704600" },
  [S.IDLE]: { fill: "#d9eaff", stroke: "#3f76b5", text: "#17456f" },
  [S.ARM]: { fill: "#fff2c6", stroke: "#c98500", text: "#704600" },
  [S.READY]: { fill: "#d9efff", stroke: "#1374b7", text: "#075083" },
  [S.RUN]: { fill: "#dff3d9", stroke: "#329031", text: "#1e671c" },
  [S.FAIL]: { fill: "#ffdada", stroke: "#c43a3a", text: "#8e2222" },
};

const ND = { fill: "#f1f5f9", stroke: "#cbd5e1", text: "#94a3b8" };

// ─────────────────────────────────────────────────────────
//  PHYSICS SIMULATION
// ─────────────────────────────────────────────────────────
const rand = () => Math.random() - 0.5;
const simCurrent = (pct) => {
  if (pct <= 0) return +(0.04 + Math.random() * 0.03).toFixed(3);
  const n = Math.min(pct, 70) / 70;
  return +(0.4 + 15.5 * Math.pow(n, 1.75) + rand() * 0.45).toFixed(3);
};
const simThrust = (pct, cal) => {
  if (!cal || pct <= 0) return null;
  const n = Math.min(pct, 70) / 70;
  return +Math.max(0, 502 * Math.pow(n, 2.1) + rand() * 11).toFixed(2);
};
const simRpm = (pct) => Math.round((Math.min(pct, 70) / 70) * 13000);
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
};

function getEnabled(state, isTared) {
  const armed = state === S.READY || state === S.RUN;
  const blocked = state === S.ARM;
  return {
    connect: state === S.DISC,
    disconnect: state !== S.DISC && !blocked,
    on: (state === S.IDLE || state === S.FAIL) && !blocked,
    off: armed && !blocked,
    stop: state === S.RUN,
    setSpeed: armed && !blocked,
    tare: state !== S.DISC && state !== S.ZERO && !blocked,
    cal: state !== S.DISC && state !== S.ZERO && isTared && !blocked,
  };
}

const HINTS = {
  on: {
    [S.DISC]: "Not connected",
    [S.ZERO]: "Wait for zero calibration to complete",
    [S.ARM]: "Arming in progress — all commands blocked for 2 s",
    [S.READY]: "Motor already armed — send OFF to disarm first",
    [S.RUN]: "Motor running — send OFF to disarm first",
  },
  stop: {
    [S.DISC]: "Not connected",
    [S.ZERO]: "Motor not armed",
    [S.IDLE]:
      "Firmware quirk: STOP when disarmed silently turns off logging instead of stopping motor",
    [S.ARM]: "Arming in progress — all commands blocked for 2 s",
    [S.READY]: "Already at MIN throttle — use OFF to disarm or SPEED to run",
    [S.FAIL]: "Motor already killed",
  },
  setSpeed: {
    [S.DISC]: "Not connected",
    [S.ZERO]: "Motor not armed",
    [S.IDLE]: "Motor not armed — send ON first to arm",
    [S.ARM]: "Arming in progress — wait 2 s before sending SPEED",
    [S.FAIL]: "Motor killed by failsafe — send ON to re-arm",
  },
};
const getHint = (state, key, isTared) =>
  getEnabled(state, isTared)[key] ? null : (HINTS[key]?.[state] ?? null);

function StateDiagram({ state }) {
  const arrow = {
    stroke: "#7f93aa",
    strokeWidth: 1.8,
    fill: "none",
    markerEnd: "url(#sda)",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
  const arrowSoft = {
    ...arrow,
    stroke: "#9aacbf",
    strokeWidth: 1.45,
  };
  const label = {
    fill: "#52657c",
    fontSize: 10,
    fontFamily: "monospace",
    fontWeight: 600,
  };

  // Layout: main flow vertical on left, side states (ARMING, FAILSAFE) on right
  const nodes = [
    { id: S.DISC, cx: 260, cy: 50, w: 180, h: 42 },
    { id: S.ZERO, cx: 260, cy: 140, w: 180, h: 42 },
    { id: S.IDLE, cx: 260, cy: 230, w: 180, h: 42 },
    { id: S.ARM, cx: 525, cy: 230, w: 160, h: 42 },
    { id: S.READY, cx: 260, cy: 325, w: 180, h: 42 },
    { id: S.RUN, cx: 260, cy: 425, w: 180, h: 42 },
    { id: S.FAIL, cx: 525, cy: 425, w: 160, h: 42 },
  ];

  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 700 500"
      preserveAspectRatio="xMidYMid meet"
      style={{ overflow: "visible", display: "block" }}
    >
      <defs>
        <marker
          id="sda"
          viewBox="0 0 10 10"
          refX="8.8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#7f93aa" />
        </marker>
      </defs>

      {/* ─── Forward flow (vertical main spine) ─── */}
      <line x1="260" y1="71" x2="260" y2="119" {...arrow} />
      <text x="272" y="100" {...label}>
        Connect
      </text>

      <line x1="260" y1="161" x2="260" y2="209" {...arrow} />
      <text x="272" y="190" {...label}>
        Cal done
      </text>

      <line x1="260" y1="346" x2="260" y2="404" {...arrow} />
      <text x="272" y="380" {...label}>
        SPEED &gt; 0
      </text>

      {/* ─── IDLE → ARMING (rightward) ─── */}
      <line x1="350" y1="230" x2="445" y2="230" {...arrow} />
      <text x="397" y="221" {...label} textAnchor="middle">
        ON
      </text>

      {/* ─── ARMING → READY (smooth curve down-left) ─── */}
      <path d="M 525 251 C 525 298 425 325 350 325" {...arrow} />
      <text x="453" y="283" {...label} textAnchor="middle">
        Armed after 2 s
      </text>

      {/* ─── RUNNING → FAILSAFE (rightward) ─── */}
      <line x1="350" y1="425" x2="445" y2="425" {...arrow} />
      <text x="397" y="416" {...label} textAnchor="middle">
        30 s timeout
      </text>

      {/* ─── FAILSAFE → ARMING (smooth curve up the right side) ─── */}
      <path d="M 605 425 C 660 425 660 230 605 230" {...arrowSoft} />
      <text x="667" y="328" {...label} textAnchor="middle">
        ON re-arm
      </text>

      {/* ─── Back-transitions, 3 concentric curves on the left ─── */}
      {/* Innermost: RUNNING → READY (STOP / 0) */}
      <path d="M 170 425 C 120 425 120 325 170 325" {...arrowSoft} />
      <text x="120" y="378" {...label} textAnchor="end">
        <tspan x="120" dy="0">
          STOP
        </tspan>
        <tspan x="120" dy="13">
          / 0
        </tspan>
      </text>

      {/* Middle: READY → IDLE (OFF) */}
      <path d="M 170 325 C 80 325 80 230 170 230" {...arrowSoft} />
      <text x="100" y="292" {...label} textAnchor="end">
        OFF
      </text>

      {/* Outermost: RUNNING → IDLE (OFF) */}
      <path d="M 170 425 C 40 425 40 230 170 230" {...arrowSoft} />
      <text x="60" y="330" {...label} textAnchor="end">
        OFF
      </text>

      {nodes.map((n) => {
        const active = n.id === state;
        const ns = active ? NS[n.id] : ND;
        const x = n.cx - n.w / 2;
        const y = n.cy - n.h / 2;
        return (
          <g key={n.id} opacity={active ? 1 : 0.58}>
            <rect
              x={x}
              y={y}
              width={n.w}
              height={n.h}
              rx={11}
              fill={ns.fill}
              stroke={ns.stroke}
              strokeWidth={active ? 2.2 : 1.2}
            />
            {active && (
              <rect
                x={x - 4}
                y={y - 4}
                width={n.w + 8}
                height={n.h + 8}
                rx={14}
                fill="none"
                stroke={ns.stroke}
                strokeWidth={1.4}
                opacity={0.3}
              />
            )}
            <text
              x={n.cx}
              y={n.cy}
              textAnchor="middle"
              dominantBaseline="central"
              style={{
                fontSize: 14,
                fontWeight: 800,
                fontFamily: "monospace",
                fill: ns.text,
              }}
            >
              {SM[n.id].label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MotorGauge({ throttle, state, rpm }) {
  const pct = Math.min(throttle, 70);
  const norm = pct / 70;
  const CX = 80;
  const CY = 82;
  const R = 62;
  const toR = (d) => (d * Math.PI) / 180;
  const pt = (d) => ({
    x: CX + R * Math.cos(toR(d)),
    y: CY + R * Math.sin(toR(d)),
  });
  const START = -225;
  const SWEEP = 270;
  const arc = (a1, a2) => {
    const s = pt(a1);
    const e = pt(a2);
    const lg = Math.abs(a2 - a1) > 180 ? 1 : 0;
    return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${R} ${R} 0 ${lg} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
  };
  const endAngle = START + norm * SWEEP;
  const dotPt = pt(endAngle);
  const col = SM[state].accent;
  const us = 1000 + Math.round((pct / 70) * 1000);

  return (
    <svg width="160" height="168" viewBox="0 0 160 168">
      <path
        d={arc(START, START + SWEEP)}
        fill="none"
        stroke="#dbe5f0"
        strokeWidth="10"
        strokeLinecap="round"
      />
      {pct > 0 && (
        <path
          d={arc(START, endAngle)}
          fill="none"
          stroke={col}
          strokeWidth="10"
          strokeLinecap="round"
        />
      )}
      {pct > 0 && <circle cx={dotPt.x} cy={dotPt.y} r="5" fill={col} />}
      <text
        x="80"
        y="70"
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontSize: 24,
          fontWeight: 800,
          fontFamily: "monospace",
          fill: THEME.text,
        }}
      >
        {pct}%
      </text>
      <text
        x="80"
        y="90"
        textAnchor="middle"
        style={{
          fontSize: 9,
          fontFamily: "monospace",
          fill: THEME.muted,
          letterSpacing: 1,
        }}
      >
        THROTTLE
      </text>
      <text
        x="80"
        y="107"
        textAnchor="middle"
        style={{ fontSize: 10, fontFamily: "monospace", fill: col }}
      >
        {us} µs
      </text>
      {state === S.RUN ? (
        <text
          x="80"
          y="123"
          textAnchor="middle"
          style={{ fontSize: 10, fontFamily: "monospace", fill: col }}
        >
          ~{rpm.toLocaleString()} RPM
        </text>
      ) : (
        <text
          x="80"
          y="123"
          textAnchor="middle"
          style={{ fontSize: 10, fontFamily: "monospace", fill: THEME.faint }}
        >
          {state === S.ARM
            ? "ARMING…"
            : state === S.READY
              ? "ARMED IDLE"
              : "IDLE"}
        </text>
      )}
      <text
        x="13"
        y="148"
        textAnchor="middle"
        style={{ fontSize: 7, fontFamily: "monospace", fill: THEME.muted }}
      >
        0
      </text>
      <text
        x="148"
        y="148"
        textAnchor="middle"
        style={{ fontSize: 7, fontFamily: "monospace", fill: THEME.muted }}
      >
        70%
      </text>
    </svg>
  );
}

function Card({ label, value, color, sub }) {
  return (
    <div className="light-card">
      <div className="lbl">{label}</div>
      <div
        style={{
          fontSize: 15,
          fontWeight: 800,
          fontFamily: "monospace",
          color: color || THEME.text,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 9, color: THEME.muted, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const MAX_PTS = 300;
const FAILSAFE_MS = 30000;
const ZERO_MS = 3000;
const ARM_MS = 2000;
const LOG_MS = 100;

export default function App() {
  const [state, setState] = useState(S.DISC);
  const [throttle, setThrottle] = useState(0);
  const [speedInput, setSpeedInput] = useState("40");
  const [calInput, setCalInput] = useState("100");
  const [data, setData] = useState([]);
  const [logs, setLogs] = useState([]);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [isTared, setIsTared] = useState(false);
  const [isCal, setIsCal] = useState(false);
  const [connMs, setConnMs] = useState(0);
  const [runMs, setRunMs] = useState(0);
  const [progPct, setProgPct] = useState(0);
  const [lastTrans, setLastTrans] = useState(null);
  const [page, setPage] = useState("dash");
  const [rpm, setRpm] = useState(0);
  const [latestRow, setLatestRow] = useState(null);
  const [cmdInput, setCmdInput] = useState("");
  const [failsafeMs, setFailsafeMs] = useState(null);

  const stRef = useRef(S.DISC);
  const thrRef = useRef(0);
  const connT0 = useRef(null);
  const runT0 = useRef(null);
  const cmdT0 = useRef(null);
  const calRef = useRef(false);
  const tarRef = useRef(false);
  const runCtr = useRef(0);
  const arRef = useRef(null);
  const dataRef = useRef([]);
  const logEl = useRef(null);
  const lastLog = useRef(0);

  const addLog = useCallback((msg, type = "info") => {
    const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
    setLogs((prev) => [...prev.slice(-400), { ts, msg, type }]);
  }, []);

  const transition = useCallback(
    (ns, reason) => {
      stRef.current = ns;
      setState(ns);
      setLastTrans({ to: ns, reason });
      addLog(`→ STATE: ${SM[ns].label}  (${reason})`, "state");
    },
    [addLog],
  );

  const finalizeRun = useCallback(
    (reason) => {
      const ar = arRef.current;
      if (!ar) return;
      const dur = (Date.now() - ar.startMs) / 1000;
      setRuns((prev) => [
        ...prev,
        {
          ...ar,
          endTime: new Date().toLocaleTimeString(),
          endReason: reason,
          duration: dur,
        },
      ]);
      arRef.current = null;
      setActiveRun(null);
      addLog(
        `Run #${ar.id} ended: ${reason}  (${dur.toFixed(1)} s, ${ar.samples} samples)`,
        "run",
      );
    },
    [addLog],
  );

  useEffect(() => {
    let raf;
    let zeroT0 = null;
    let armT0 = null;

    const tick = () => {
      const now = Date.now();
      const st = stRef.current;
      const thr = thrRef.current;

      if (connT0.current) setConnMs(now - connT0.current);
      if (runT0.current && st === S.RUN) setRunMs(now - runT0.current);

      if ((st === S.READY || st === S.RUN) && cmdT0.current) {
        setFailsafeMs(Math.max(0, FAILSAFE_MS - (now - cmdT0.current)));
      } else {
        setFailsafeMs(null);
      }

      if (st === S.ZERO) {
        if (!zeroT0) zeroT0 = now;
        const elapsed = now - zeroT0;
        setProgPct(Math.min(100, (elapsed / ZERO_MS) * 100));
        if (elapsed >= ZERO_MS) {
          zeroT0 = null;
          transition(S.IDLE, "Zero calibration complete");
          addLog("zeroRaw = 2048.3  Baseline calibrated ✓", "ok");
        }
      } else {
        zeroT0 = null;
      }

      if (st === S.ARM) {
        if (!armT0) armT0 = now;
        const elapsed = now - armT0;
        setProgPct(Math.min(100, (elapsed / ARM_MS) * 100));
        if (elapsed >= ARM_MS) {
          armT0 = null;
          cmdT0.current = Date.now();
          transition(S.READY, "Arm sequence complete → motor enabled");
          addLog("Armed. Commands unblocked. Send SPEED > 0 to run.", "ok");
        }
      } else {
        armT0 = null;
      }

      if (
        (st === S.READY || st === S.RUN) &&
        cmdT0.current &&
        now - cmdT0.current >= FAILSAFE_MS
      ) {
        thrRef.current = 0;
        setThrottle(0);
        setRpm(0);
        runT0.current = null;
        setRunMs(0);
        finalizeRun("Command timeout (30 s)");
        transition(S.FAIL, "30 s command timeout");
        addLog("⚠ FAILSAFE: Motor disabled — command timeout.", "err");
        addLog("Motor disabled due to command timeout.", "err");
      }

      if (
        (st === S.IDLE || st === S.READY || st === S.RUN) &&
        now - lastLog.current >= LOG_MS
      ) {
        lastLog.current = now;
        const elapsed = connT0.current ? (now - connT0.current) / 1000 : 0;
        const cur = simCurrent(st === S.RUN ? thr : 0);
        const thrG = simThrust(st === S.RUN ? thr : 0, calRef.current);
        const row = { t: +elapsed.toFixed(2), current: cur, thrust: thrG ?? 0 };
        setLatestRow(row);
        dataRef.current = [...dataRef.current.slice(-(MAX_PTS - 1)), row];
        setData([...dataRef.current]);

        if (arRef.current && st === S.RUN) {
          const ar = arRef.current;
          ar.samples++;
          ar.currentSum += cur;
          if (thrG !== null) {
            ar.thrustSum += thrG;
            ar.thrustSamples++;
          }
          setActiveRun({ ...ar, duration: (Date.now() - ar.startMs) / 1000 });
          arRef.current = ar;
        }
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [transition, addLog, finalizeRun]);

  useEffect(() => {
    if (logEl.current) logEl.current.scrollTop = logEl.current.scrollHeight;
  }, [logs]);

  const handleCmd = useCallback(
    (raw) => {
      const up = raw.trim().toUpperCase();
      const st = stRef.current;

      if (st === S.ARM) {
        addLog(`CMD BLOCKED: '${raw.trim()}' — arming in progress`, "err");
        return;
      }

      addLog(`> ${raw.trim()}`, "cmd");

      if (up === "CONNECT") {
        if (st !== S.DISC) {
          addLog("ERR: Already connected.", "err");
          return;
        }
        connT0.current = Date.now();
        cmdT0.current = Date.now();
        setConnMs(0);
        dataRef.current = [];
        setData([]);
        setIsTared(false);
        setIsCal(false);
        tarRef.current = false;
        calRef.current = false;
        transition(S.ZERO, "Serial port opened @ 115200 baud");
        addLog("Bluetooth ready: ESP32_Motor_Current_LoadCell", "ok");
        addLog("CSV header: ms,raw,v,currentA,lc_raw,lc_grams", "info");
        return;
      }

      if (up === "DISCONNECT") {
        thrRef.current = 0;
        setThrottle(0);
        setRpm(0);
        connT0.current = null;
        runT0.current = null;
        cmdT0.current = null;
        setConnMs(0);
        setRunMs(0);
        setProgPct(0);
        setFailsafeMs(null);
        finalizeRun("Disconnect");
        transition(S.DISC, "User disconnected");
        return;
      }

      if (st === S.DISC || st === S.ZERO) {
        addLog("ERR: Not ready — wait for IDLE state.", "err");
        return;
      }

      cmdT0.current = Date.now();

      if (up === "ON") {
        if (st === S.READY || st === S.RUN) {
          addLog("ERR: Motor already armed. Send OFF first to disarm.", "err");
          return;
        }
        transition(S.ARM, "ON command received");
        setProgPct(0);
        addLog("Arming: holding MIN throttle (1000 µs) for 2 s…", "info");
        addLog("⚠ All commands blocked during arm sequence.", "info");
        return;
      }

      if (up === "OFF") {
        if (st !== S.READY && st !== S.RUN) {
          addLog("ERR: Motor not armed.", "err");
          return;
        }
        thrRef.current = 0;
        setThrottle(0);
        setRpm(0);
        runT0.current = null;
        setRunMs(0);
        finalizeRun("OFF command");
        transition(S.IDLE, "OFF — motor disarmed");
        addLog("OK OFF (motor disabled, throttle = MIN)", "ok");
        return;
      }

      if (up === "STOP") {
        if (st === S.RUN) {
          thrRef.current = 0;
          setThrottle(0);
          setRpm(0);
          runT0.current = null;
          setRunMs(0);
          finalizeRun("STOP command");
          transition(S.READY, "STOP — throttle MIN, motor still armed");
          addLog("OK Throttle = 0%  pulse = 1000 µs", "ok");
        } else if (st === S.IDLE) {
          addLog(
            "⚠ FIRMWARE QUIRK: STOP when motor is disarmed → logging turned OFF",
            "err",
          );
        } else if (st === S.READY) {
          addLog(
            "Motor already at MIN throttle. Use OFF to disarm, or SPEED to run.",
            "info",
          );
        } else {
          addLog("ERR: STOP not valid in current state.", "err");
        }
        return;
      }

      if (up.startsWith("SPEED")) {
        const val = parseInt(raw.trim().split(/\s+/)[1] ?? "0", 10);
        if (Number.isNaN(val) || val < 0 || val > 100) {
          addLog("ERR: SPEED must be 0–100.", "err");
          return;
        }
        if (st !== S.READY && st !== S.RUN) {
          addLog("ERR: Motor not armed. Send ON first.", "err");
          return;
        }
        const capped = Math.min(val, 70);
        const us = 1000 + Math.round((capped / 70) * 1000);
        if (val === 0) {
          thrRef.current = 0;
          setThrottle(0);
          setRpm(0);
          runT0.current = null;
          setRunMs(0);
          finalizeRun("SPEED 0");
          if (st === S.RUN) transition(S.READY, "SPEED 0 → throttle MIN");
          addLog("OK Throttle = 0%  pulse = 1000 µs", "ok");
        } else {
          finalizeRun("New SPEED command");
          thrRef.current = capped;
          setThrottle(capped);
          setRpm(simRpm(capped));
          runT0.current = Date.now();
          setRunMs(0);
          runCtr.current++;
          const nr = {
            id: runCtr.current,
            startTime: new Date().toLocaleTimeString(),
            startCmd: `SPEED ${val}`,
            startMs: Date.now(),
            samples: 0,
            currentSum: 0,
            thrustSum: 0,
            thrustSamples: 0,
          };
          arRef.current = nr;
          setActiveRun({ ...nr, duration: 0 });
          transition(S.RUN, `SPEED ${val} → ${capped}% effective`);
          addLog(`OK Throttle = ${val}% (capped 70%)  pulse = ${us} µs`, "ok");
        }
        return;
      }

      if (up === "TARE") {
        addLog("Taring… collecting 80 samples…", "info");
        setTimeout(() => {
          tarRef.current = true;
          setIsTared(true);
          addLog("Tare complete. Offset = 847291", "ok");
        }, 1500);
        return;
      }

      if (up.startsWith("CAL=")) {
        const w = parseFloat(raw.split("=")[1]);
        if (!tarRef.current) {
          addLog("ERR: TARE first before calibrating.", "err");
          return;
        }
        if (Number.isNaN(w) || w <= 0) {
          addLog("ERR: Weight must be > 0 g.", "err");
          return;
        }
        addLog(`Calibrating with ${w} g… 100 samples…`, "info");
        setTimeout(() => {
          calRef.current = true;
          setIsCal(true);
          addLog(`Cal factor: ${(202531.5 / w).toFixed(4)} counts/g`, "ok");
          addLog("Calibration complete.", "ok");
        }, 2000);
        return;
      }

      if (up === "STATUS") {
        const us =
          1000 + Math.round((Math.min(thrRef.current, 70) / 70) * 1000);
        const fs = cmdT0.current
          ? ((FAILSAFE_MS - (Date.now() - cmdT0.current)) / 1000).toFixed(1)
          : "N/A";
        addLog(
          `STATE=${SM[stRef.current].label}  THROTTLE=${thrRef.current}%  PULSE=${us} µs`,
          "info",
        );
        addLog(
          `TARED=${tarRef.current}  CALIBRATED=${calRef.current}  FAILSAFE_IN=${fs} s`,
          "info",
        );
        return;
      }

      if (up === "HELP") {
        addLog("Motor:      ON / OFF / STOP / SPEED <0-100>", "info");
        addLog("Load cell:  TARE / CAL=<grams> / STATUS", "info");
        addLog("Connection: CONNECT / DISCONNECT", "info");
        return;
      }

      addLog(`Unknown command: '${raw.trim()}'. Type HELP.`, "err");
    },
    [addLog, transition, finalizeRun],
  );

  const sendCmd = () => {
    if (cmdInput.trim()) {
      handleCmd(cmdInput.trim());
      setCmdInput("");
    }
  };

  const meta = SM[state];
  const en = getEnabled(state, isTared);
  const isConn = state !== S.DISC;
  const curVal = latestRow?.current ?? null;
  const thrustVal = latestRow?.thrust > 0.1 ? latestRow.thrust : null;
  const tiRatio =
    curVal && thrustVal && curVal > 0.5
      ? (thrustVal / curVal).toFixed(2)
      : null;
  const us = 1000 + Math.round((Math.min(throttle, 70) / 70) * 1000);
  const fsWarn = failsafeMs !== null && failsafeMs < 8000;

  const logColor = (type) =>
    ({
      state: "#0c88d8",
      cmd: "#b77900",
      ok: "#248c24",
      err: "#c53030",
      run: "#7c3aed",
      info: "#64748b",
    })[type] || "#64748b";

  return (
    <div
      style={{
        fontFamily: "monospace",
        background: THEME.page,
        minHeight: "100vh",
        padding: "12px 10px 28px",
        color: THEME.text,
      }}
    >
      <style>{`
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:7px;height:7px}
        ::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:999px}
        .sp{background:${THEME.panel};border:1px solid ${THEME.border};border-radius:16px;padding:14px;box-shadow:${THEME.shadow}}
        .light-card{background:${THEME.card};border:1px solid ${THEME.border};border-radius:12px;padding:10px 12px;box-shadow:0 4px 14px rgba(15,35,65,.05)}
        .btn{border:1px solid ${THEME.borderStrong};border-radius:10px;padding:7px 11px;cursor:pointer;font-family:monospace;font-size:11px;color:${THEME.text};background:#ffffff;transition:background .12s,transform .08s,border-color .12s;white-space:nowrap}
        .btn:hover:not(:disabled){background:#f1f5f9;border-color:#94a3b8}
        .btn:active:not(:disabled){transform:scale(.97)}
        .btn:disabled{opacity:.42;cursor:not-allowed}
        .btn-p{background:#e7f3ff;border-color:#76afe0;color:#07598f}
        .btn-p:hover:not(:disabled){background:#d8ecff}
        .btn-d{background:#fff0f0;border-color:#f0a1a1;color:#a42626}
        .btn-d:hover:not(:disabled){background:#ffe2e2}
        .btn-s{background:#ecf9e8;border-color:#8ed889;color:#21721f}
        .btn-s:hover:not(:disabled){background:#ddf4d6}
        .btn-w{background:#fff7df;border-color:#e6bd5b;color:#8a5a00}
        .btn-w:hover:not(:disabled){background:#fff0bf}
        .inp{border:1px solid ${THEME.borderStrong};border-radius:10px;padding:7px 10px;font-family:monospace;font-size:11px;color:${THEME.text};background:${THEME.input};width:100%;outline:none}
        .inp:focus{border-color:#0c88d8;box-shadow:0 0 0 3px rgba(12,136,216,.12)}
        .lbl{font-size:8px;color:${THEME.muted};letter-spacing:.9px;text-transform:uppercase;margin-bottom:4px}
        .div{border:none;border-top:1px solid ${THEME.border};margin:11px 0}
        .sec{font-size:9px;font-weight:800;color:${THEME.muted};letter-spacing:1.3px;text-transform:uppercase;margin-bottom:9px}
        .tab{background:none;border:none;border-bottom:2px solid transparent;padding:8px 16px;font-family:monospace;font-size:11px;cursor:pointer;color:${THEME.muted}}
        .tab:hover{color:${THEME.text}}
        .tab.active{color:#07598f;border-bottom-color:#0c88d8}
        .badge{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.5px;font-family:monospace}
        .hint{font-size:9px;margin-top:5px;padding:5px 8px;border-radius:9px;line-height:1.45}
        .rtbl{width:100%;border-collapse:collapse;font-size:10px}
        .rtbl th{color:${THEME.muted};text-align:left;padding:7px 8px;border-bottom:1px solid ${THEME.border};font-weight:700;white-space:nowrap;background:#f8fafc}
        .rtbl td{padding:7px 8px;border-bottom:1px solid #edf2f7;color:${THEME.text};white-space:nowrap}
        .rtbl tr:hover td{background:#f8fafc}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.28}}
        @keyframes pulse{0%,100%{opacity:.72}50%{opacity:1}}
        .blink{animation:blink 1s ease-in-out infinite}
        .pulse{animation:pulse 1.4s ease-in-out infinite}
      `}</style>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: 1.5 }}>
          ESP32 MOTOR TEST STAND
        </span>
        <span style={{ fontSize: 9, color: THEME.faint }}>
          LIGHT THEME SIMULATOR
        </span>
        <span
          className={`badge ${state === S.FAIL ? "blink" : state === S.RUN ? "pulse" : ""}`}
          style={{
            background: meta.bg,
            border: `1px solid ${meta.border}`,
            color: meta.text,
          }}
        >
          ● {meta.label}
        </span>
        <span style={{ fontSize: 10, color: THEME.muted }}>{meta.desc}</span>
        {state === S.ARM && (
          <span
            className="blink"
            style={{
              fontSize: 10,
              color: "#8a5a00",
              background: "#fff7df",
              border: "1px solid #d89b12",
              borderRadius: 9,
              padding: "3px 8px",
            }}
          >
            ⚠ COMMANDS BLOCKED
          </span>
        )}
        <div style={{ marginLeft: "auto" }}>
          <button
            className={`tab${page === "dash" ? " active" : ""}`}
            onClick={() => setPage("dash")}
          >
            Dashboard
          </button>
          <button
            className={`tab${page === "summary" ? " active" : ""}`}
            onClick={() => setPage("summary")}
          >
            Run summary
          </button>
        </div>
      </div>

      {page === "dash" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "280px minmax(0, 1fr) 460px",
            gap: 10,
            alignItems: "stretch",
          }}
        >
          {/* ────────── LEFT COLUMN: Controls only ────────── */}
          <div
            className="sp"
            style={{ display: "flex", flexDirection: "column", gap: 7 }}
          >
            <div className="sec">Connection</div>
            <select className="inp" style={{ marginBottom: 3 }}>
              <option>COM3 (ESP32)</option>
              <option>COM4</option>
              <option>/dev/ttyUSB0</option>
            </select>
            <select className="inp" style={{ marginBottom: 5 }}>
              <option>115200 baud</option>
              <option>9600 baud</option>
            </select>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 6,
              }}
            >
              <button
                className="btn btn-s"
                onClick={() => handleCmd("CONNECT")}
                disabled={!en.connect}
              >
                Connect
              </button>
              <button
                className="btn btn-d"
                onClick={() => handleCmd("DISCONNECT")}
                disabled={!en.disconnect}
              >
                Disconnect
              </button>
            </div>
            <div
              style={{ fontSize: 9, color: isConn ? "#21721f" : THEME.faint }}
            >
              {isConn ? "● COM3 @ 115200 baud" : "○ Disconnected"}
            </div>

            <hr className="div" />
            <div className="sec">Motor control</div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 6,
              }}
            >
              <button
                className="btn btn-p"
                onClick={() => handleCmd("ON")}
                disabled={!en.on}
              >
                ON
              </button>
              <button
                className="btn"
                onClick={() => handleCmd("OFF")}
                disabled={!en.off}
              >
                OFF
              </button>
              <button
                className="btn btn-d"
                onClick={() => handleCmd("STOP")}
                disabled={!en.stop}
              >
                STOP
              </button>
            </div>

            {!en.on && getHint(state, "on", isTared) && (
              <div
                className="hint"
                style={{
                  background: "#fff7df",
                  color: "#8a5a00",
                  border: "1px solid #e6bd5b",
                }}
              >
                {getHint(state, "on", isTared)}
              </div>
            )}
            {!en.stop && getHint(state, "stop", isTared) && (
              <div
                className="hint"
                style={{
                  background: state === S.IDLE ? "#fff0f0" : "#f8fafc",
                  color: state === S.IDLE ? "#a42626" : THEME.muted,
                  border: `1px solid ${state === S.IDLE ? "#f0a1a1" : THEME.border}`,
                }}
              >
                {getHint(state, "stop", isTared)}
              </div>
            )}

            <div className="lbl" style={{ marginTop: 4 }}>
              Throttle % (0–100)
            </div>
            <input
              type="number"
              min="0"
              max="100"
              className="inp"
              value={speedInput}
              onChange={(e) => setSpeedInput(e.target.value)}
              style={{ marginBottom: 5 }}
              disabled={!en.setSpeed}
            />
            <button
              className="btn btn-p"
              style={{ width: "100%" }}
              onClick={() => handleCmd(`SPEED ${speedInput}`)}
              disabled={!en.setSpeed}
            >
              Set speed
            </button>
            {!en.setSpeed && getHint(state, "setSpeed", isTared) && (
              <div
                className="hint"
                style={{
                  background: "#fff7df",
                  color: "#8a5a00",
                  border: "1px solid #e6bd5b",
                }}
              >
                {getHint(state, "setSpeed", isTared)}
              </div>
            )}
            {en.setSpeed && (
              <div style={{ fontSize: 9, color: THEME.muted }}>
                Cap 70% ·{" "}
                {1000 +
                  Math.round(
                    (Math.min(parseInt(speedInput) || 0, 70) / 70) * 1000,
                  )}{" "}
                µs
              </div>
            )}

            <hr className="div" />
            <div className="sec">Load cell</div>
            <button
              className="btn btn-w"
              style={{ width: "100%", marginBottom: 5 }}
              onClick={() => handleCmd("TARE")}
              disabled={!en.tare}
            >
              Tare (zero scale)
            </button>
            <div className="lbl">Known weight (g)</div>
            <input
              type="number"
              className="inp"
              value={calInput}
              onChange={(e) => setCalInput(e.target.value)}
              style={{ marginBottom: 5 }}
              disabled={!en.cal}
            />
            <button
              className="btn"
              style={{ width: "100%" }}
              onClick={() => handleCmd(`CAL=${calInput}`)}
              disabled={!en.cal}
            >
              Calibrate
            </button>
            <div
              style={{ fontSize: 9, display: "flex", gap: 10, marginTop: 4 }}
            >
              <span style={{ color: isTared ? "#21721f" : THEME.faint }}>
                {isTared ? "✓ Tared" : "○ Tare"}
              </span>
              <span style={{ color: isCal ? "#21721f" : THEME.faint }}>
                {isCal ? "✓ Cal." : "○ Cal."}
              </span>
            </div>

            <hr className="div" />
            <div className="sec">Data</div>
            <button
              className="btn"
              style={{ width: "100%", marginBottom: 5 }}
              onClick={() => {
                dataRef.current = [];
                setData([]);
                addLog("Graph buffer cleared.", "info");
              }}
            >
              Clear graphs
            </button>
            <button
              className="btn"
              style={{ width: "100%" }}
              onClick={() => setLogs([])}
            >
              Clear console
            </button>
          </div>

          {/* ────────── CENTER COLUMN: Telemetry + Motor monitor at bottom ────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4,1fr)",
                gap: 8,
              }}
            >
              <Card
                label="Live current"
                value={curVal != null ? `${curVal.toFixed(2)} A` : "──"}
                color="#c53030"
              />
              <Card
                label="Live thrust"
                value={thrustVal != null ? `${thrustVal.toFixed(1)} g` : "──"}
                color="#248c24"
              />
              <Card
                label="Data points"
                value={String(data.length)}
                color="#0c88d8"
              />
              <Card label="Motor status" value={meta.label} color={meta.text} />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
              <div className="light-card">
                <div className="lbl">Connection timer</div>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 800,
                    letterSpacing: 3,
                    color: "#0c88d8",
                  }}
                >
                  {fmtTime(connMs)}
                </div>
              </div>
              <div className="light-card">
                <div className="lbl">Active run timer</div>
                <div
                  style={{
                    fontSize: 17,
                    fontWeight: 800,
                    letterSpacing: 3,
                    color: state === S.RUN ? "#248c24" : THEME.faint,
                  }}
                >
                  {state === S.RUN ? fmtTime(runMs) : "──:──:──"}
                </div>
              </div>
              <div
                className="light-card"
                style={{ borderColor: fsWarn ? "#f0a1a1" : THEME.border }}
              >
                <div
                  className="lbl"
                  style={{ color: fsWarn ? "#a42626" : undefined }}
                >
                  Failsafe countdown
                </div>
                {failsafeMs !== null ? (
                  <>
                    <div
                      style={{
                        fontSize: 17,
                        fontWeight: 800,
                        letterSpacing: 2,
                        color: fsWarn ? "#c53030" : THEME.muted,
                      }}
                      className={fsWarn ? "blink" : ""}
                    >
                      {(failsafeMs / 1000).toFixed(1)} s
                    </div>
                    <div
                      style={{
                        background: "#e6edf5",
                        borderRadius: 999,
                        height: 6,
                        marginTop: 6,
                      }}
                    >
                      <div
                        style={{
                          background: fsWarn ? "#c53030" : "#0c88d8",
                          width: `${(failsafeMs / FAILSAFE_MS) * 100}%`,
                          height: 6,
                          borderRadius: 999,
                          transition: "width .5s linear",
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <div
                    style={{
                      fontSize: 17,
                      color: THEME.faint,
                      letterSpacing: 2,
                    }}
                  >
                    ──
                  </div>
                )}
              </div>
            </div>

            {(state === S.ZERO || state === S.ARM) && (
              <div className="light-card" style={{ borderColor: meta.border }}>
                <div
                  className="lbl"
                  style={{ marginBottom: 6, color: meta.text }}
                >
                  {state === S.ZERO ? "Zero calibration" : "Arm sequence"} —{" "}
                  {progPct.toFixed(0)}%
                  {state === S.ARM && " · commands blocked"}
                </div>
                <div
                  style={{
                    background: "#e6edf5",
                    borderRadius: 999,
                    height: 8,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      background: meta.accent,
                      borderRadius: 999,
                      height: 8,
                      width: `${progPct}%`,
                      transition: "width .1s linear",
                    }}
                  />
                </div>
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              {[
                { label: "Current (A)", key: "current", col: "#c53030" },
                { label: "Thrust (g)", key: "thrust", col: "#248c24" },
              ].map((ch) => (
                <div
                  key={ch.key}
                  className="sp"
                  style={{ padding: "12px 6px 8px" }}
                >
                  <div
                    style={{
                      fontSize: 9,
                      color: THEME.muted,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      marginBottom: 4,
                      paddingLeft: 8,
                    }}
                  >
                    {ch.label}
                  </div>
                  <ResponsiveContainer width="100%" height={170}>
                    <LineChart
                      data={data}
                      margin={{ top: 4, right: 6, left: -28, bottom: 0 }}
                    >
                      <CartesianGrid
                        stroke={THEME.grid}
                        strokeDasharray="3 3"
                      />
                      <XAxis
                        dataKey="t"
                        stroke={THEME.grid}
                        tick={{
                          fill: THEME.muted,
                          fontSize: 9,
                          fontFamily: "monospace",
                        }}
                        tickCount={4}
                      />
                      <YAxis
                        stroke={THEME.grid}
                        tick={{
                          fill: THEME.muted,
                          fontSize: 9,
                          fontFamily: "monospace",
                        }}
                        width={42}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#ffffff",
                          border: `1px solid ${THEME.border}`,
                          borderRadius: 10,
                          fontSize: 10,
                          fontFamily: "monospace",
                          boxShadow: THEME.shadow,
                        }}
                        labelStyle={{ color: THEME.muted }}
                        formatter={(v) => [v?.toFixed(3), ch.label]}
                        labelFormatter={(v) => `t = ${v} s`}
                      />
                      <Line
                        type="monotone"
                        dataKey={ch.key}
                        stroke={ch.col}
                        dot={false}
                        strokeWidth={1.8}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </div>

            <div className="sp">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <div className="sec" style={{ marginBottom: 0 }}>
                  Console output
                </div>
                <div style={{ fontSize: 9, color: THEME.faint }}>
                  session_logs/serial_log.txt
                </div>
              </div>
              <div
                ref={logEl}
                style={{
                  background: THEME.console,
                  border: `1px solid ${THEME.border}`,
                  borderRadius: 12,
                  padding: "9px 11px",
                  height: 145,
                  overflowY: "auto",
                  fontSize: 10,
                  lineHeight: 1.75,
                }}
              >
                {logs.length === 0 ? (
                  <div style={{ color: THEME.faint }}>
                    No output. Click Connect to begin.
                  </div>
                ) : (
                  logs.map((ln, i) => (
                    <div key={i}>
                      <span style={{ color: THEME.faint }}>[{ln.ts}] </span>
                      <span style={{ color: logColor(ln.type) }}>{ln.msg}</span>
                    </div>
                  ))
                )}
              </div>
              <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
                <input
                  className="inp"
                  style={{ flex: 1 }}
                  placeholder="Type command, e.g. SPEED 50, then press Enter…"
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendCmd();
                  }}
                />
                <button
                  className="btn btn-p"
                  style={{ flexShrink: 0 }}
                  onClick={sendCmd}
                >
                  Send
                </button>
              </div>
            </div>

            {/* ────────── MOTOR MONITOR — moved to center bottom ────────── */}
            <div className="sp">
              <div className="sec">Motor monitor</div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ flexShrink: 0 }}>
                  <MotorGauge throttle={throttle} state={state} rpm={rpm} />
                </div>
                <div
                  style={{
                    flex: 1,
                    minWidth: 260,
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: 8,
                  }}
                >
                  <Card
                    label="Current"
                    value={curVal != null ? `${curVal.toFixed(2)} A` : "──"}
                    color="#c53030"
                  />
                  <Card
                    label="Thrust"
                    value={
                      thrustVal != null ? `${thrustVal.toFixed(1)} g` : "──"
                    }
                    color="#248c24"
                  />
                  <Card
                    label="T/I ratio"
                    value={tiRatio != null ? `${tiRatio} g/A` : "──"}
                    color={THEME.text}
                  />
                  <Card label="Pulse" value={`${us} µs`} color={meta.accent} />
                </div>
              </div>
            </div>
          </div>

          {/* ────────── RIGHT COLUMN: State machine, fills full height ────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              className="sp"
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              <div className="sec">State machine</div>
              {lastTrans && (
                <div
                  style={{
                    background: meta.bg,
                    border: `1px solid ${meta.border}`,
                    color: meta.text,
                    borderRadius: 10,
                    padding: "5px 10px",
                    fontSize: 10,
                    marginBottom: 8,
                    lineHeight: 1.5,
                  }}
                >
                  ← {lastTrans.reason}
                </div>
              )}
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "8px 0",
                }}
              >
                <StateDiagram state={state} />
              </div>
            </div>
          </div>
        </div>
      )}

      {page === "summary" && <SummaryPage runs={runs} activeRun={activeRun} />}
    </div>
  );
}

function SummaryPage({ runs, activeRun }) {
  const all = [
    ...runs,
    ...(activeRun
      ? [
          {
            ...activeRun,
            status: "ACTIVE",
            endTime: "─",
            endReason: "─",
            duration: activeRun.duration ?? 0,
          },
        ]
      : []),
  ];
  const last = runs[runs.length - 1];
  const latestEff =
    last && last.thrustSamples && last.samples
      ? `${(last.thrustSum / last.thrustSamples / (last.currentSum / last.samples)).toFixed(2)} g/A`
      : "─";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4,1fr)",
          gap: 8,
        }}
      >
        <Card
          label="Completed runs"
          value={String(runs.length)}
          color="#0c88d8"
        />
        <Card
          label="Active run"
          value={activeRun ? "YES" : "NO"}
          color={activeRun ? "#b77900" : THEME.faint}
        />
        <Card
          label="Latest run start"
          value={last ? last.startTime : "─"}
          color="#248c24"
        />
        <Card label="Latest avg T/I" value={latestEff} color={THEME.text} />
      </div>

      {activeRun && (
        <div className="sp">
          <div className="sec">Active run detail</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4,1fr)",
              gap: 8,
            }}
          >
            {[
              { l: "Run #", v: String(activeRun.id) },
              { l: "Start", v: activeRun.startTime },
              { l: "Command", v: activeRun.startCmd },
              {
                l: "Duration (s)",
                v: (+activeRun.duration).toFixed(2),
                blink: true,
              },
              { l: "Samples", v: String(activeRun.samples) },
              {
                l: "Avg I (A)",
                v: activeRun.samples
                  ? (activeRun.currentSum / activeRun.samples).toFixed(3)
                  : "─",
              },
              {
                l: "Avg T (g)",
                v: activeRun.thrustSamples
                  ? (activeRun.thrustSum / activeRun.thrustSamples).toFixed(2)
                  : "─",
              },
              {
                l: "Avg T/I",
                v:
                  activeRun.samples && activeRun.thrustSamples
                    ? (
                        activeRun.thrustSum /
                        activeRun.thrustSamples /
                        (activeRun.currentSum / activeRun.samples)
                      ).toFixed(2)
                    : "─",
              },
            ].map((it) => (
              <div key={it.l} className="light-card">
                <div className="lbl">{it.l}</div>
                <div
                  className={it.blink ? "blink" : ""}
                  style={{ fontSize: 13, fontWeight: 800, color: "#b77900" }}
                >
                  {it.v}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sp" style={{ overflowX: "auto" }}>
        <div className="sec">
          Run table{" "}
          <span style={{ fontWeight: 400, color: THEME.faint, marginLeft: 8 }}>
            (metrics only from RUN state)
          </span>
        </div>
        {all.length === 0 ? (
          <div
            style={{
              color: THEME.faint,
              textAlign: "center",
              padding: "28px 0",
              fontSize: 12,
            }}
          >
            No run data yet. Connect → ON → SPEED &gt; 0 to begin.
          </div>
        ) : (
          <table className="rtbl">
            <thead>
              <tr>
                {[
                  "#",
                  "Status",
                  "Start",
                  "Command",
                  "End",
                  "End reason",
                  "Dur (s)",
                  "Samples",
                  "Avg I (A)",
                  "Avg T (g)",
                  "Avg T/I (g/A)",
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {all.map((r, i) => {
                const avgI = r.samples
                  ? (r.currentSum / r.samples).toFixed(3)
                  : "─";
                const avgT = r.thrustSamples
                  ? (r.thrustSum / r.thrustSamples).toFixed(2)
                  : "─";
                const avgTI =
                  r.samples && r.thrustSamples
                    ? (
                        r.thrustSum /
                        r.thrustSamples /
                        (r.currentSum / r.samples)
                      ).toFixed(2)
                    : "─";
                const dur = r.duration != null ? (+r.duration).toFixed(2) : "─";
                const isAct = r.status === "ACTIVE";
                return (
                  <tr key={i}>
                    <td>{r.id}</td>
                    <td>
                      {isAct ? (
                        <span className="blink" style={{ color: "#b77900" }}>
                          ● ACTIVE
                        </span>
                      ) : (
                        <span style={{ color: "#248c24" }}>Completed</span>
                      )}
                    </td>
                    <td>{r.startTime}</td>
                    <td>{r.startCmd}</td>
                    <td>{r.endTime ?? "─"}</td>
                    <td style={{ color: THEME.muted }}>{r.endReason ?? "─"}</td>
                    <td>{dur}</td>
                    <td>{r.samples}</td>
                    <td style={{ color: "#c53030" }}>{avgI}</td>
                    <td style={{ color: "#248c24" }}>{avgT}</td>
                    <td style={{ color: "#0c88d8" }}>{avgTI}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
