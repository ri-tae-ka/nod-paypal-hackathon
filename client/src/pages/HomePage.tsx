import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import paypalLogo from "../assets/logos/paypal.svg";
import geminiLogo from "../assets/logos/googlegemini.svg";
import channel3Logo from "../assets/logos/channel3.svg";
import agGridLogo from "../assets/logos/aggrid.png";
import postmanLogo from "../assets/logos/postman.svg";
import renderLogo from "../assets/logos/render.svg";
import mongoLogo from "../assets/logos/mongodb.svg";
import expressLogo from "../assets/logos/express.svg";
import reactLogo from "../assets/logos/react.svg";
import nodeLogo from "../assets/logos/nodedotjs.svg";
import { useMe } from "../hooks/useAuth";
import styles from "./HomePage.module.css";

const steps = [
  {
    title: "Describe what you need",
    body: "Write a request in plain English, such as “set up a home office for two engineers under $1,500”.",
  },
  {
    title: "AI builds the sheet",
    body: "An AI agent searches real products through Channel3 and assembles an editable sheet with quantities, prices and reasons.",
  },
  {
    title: "Refine and compare",
    body: "Edit cells directly or ask the agent to “upgrade quality” or “cut 20%”. Every change creates a new version you can compare.",
  },
  {
    title: "Approve and pay",
    body: "Approve the exact version you reviewed, then pay with PayPal on your own, split it with a group, or open a community pool anyone can chip in to.",
  },
];

const icon = (path: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={path} />
  </svg>
);

const featureIcons: Record<string, ReactNode> = {
  "Real products": icon("M3 4h2l2.4 11h11l2-8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"),
  "Versioned sheets": icon("M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"),
  "Budget guardrails": icon("M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4"),
  "PayPal checkout": icon("M3 6h18v12H3zM3 10h18M7 15h3"),
};

const features = [
  { title: "Real products", body: "Live catalogue search via Channel3. No made-up items or prices." },
  { title: "Versioned sheets", body: "Every AI or manual change is saved as a version with a clear diff." },
  { title: "Budget guardrails", body: "Totals are calculated on the server and checked against your budget before approval." },
  { title: "PayPal checkout", body: "Pay solo, split by share with Group Nod, or raise it as an all-or-nothing community pool with PayPal refunds." },
];

type Logo = { src: string; alt: string };

const stack: { name: string; role: string; logos: Logo[]; sponsor?: boolean }[] = [
  {
    name: "PayPal",
    role: "Built on PayPal Developer APIs and tested in the PayPal Sandbox: orders for the exact approved version, per-member shares, guest pool contributions and refunds.",
    logos: [{ src: paypalLogo, alt: "PayPal" }],
  },
  {
    name: "Google Gemini",
    role: "Plans searches, picks products, explains each choice and writes community pool pitches, all with structured JSON output.",
    logos: [{ src: geminiLogo, alt: "Google Gemini" }],
  },
  {
    name: "Channel3",
    role: "Searches a live product catalogue so every item and price is real.",
    logos: [{ src: channel3Logo, alt: "Channel3" }],
    sponsor: true,
  },
  {
    name: "AG Grid",
    role: "Powers the editable sheet, the version compare grid and the requests list, with cells that flash when the agent changes them.",
    logos: [{ src: agGridLogo, alt: "AG Grid" }],
    sponsor: true,
  },
  {
    name: "Postman",
    role: "Used to explore and test the REST API during development.",
    logos: [{ src: postmanLogo, alt: "Postman" }],
    sponsor: true,
  },
  {
    name: "Render",
    role: "Hosts the live app: API and client served from one web service.",
    logos: [{ src: renderLogo, alt: "Render" }],
    sponsor: true,
  },
  {
    name: "MongoDB, Express, React, Node",
    role: "Stores requests, versions and payments, and serves the app.",
    logos: [
      { src: mongoLogo, alt: "MongoDB" },
      { src: expressLogo, alt: "Express" },
      { src: reactLogo, alt: "React" },
      { src: nodeLogo, alt: "Node.js" },
    ],
  },
];

const principles = [
  "The AI proposes; deterministic code validates. Prices, totals and stock are always checked on the server.",
  "Every change is versioned. You approve one exact version, and later edits can't change what gets charged.",
  "The captured amount is checked against the approved total before an order is marked paid.",
  "Everything runs in the PayPal Sandbox. No real money moves.",
];

const previewRows = [
  { name: "4-person cabin tent", qty: 2, total: "$219.98" },
  { name: "Sleeping bag, 30°F", qty: 6, total: "$209.94", changed: true },
  { name: "LED camping lantern", qty: 3, total: "$59.97" },
  { name: "Camp stove + fuel", qty: 1, total: "$74.99", changed: true },
];

/** A static mock of the workspace, so the hero shows what Nod actually looks like. */
function ProductPreview() {
  return (
    <div className={styles.preview} aria-hidden>
      <div className={styles.window}>
        <div className={styles.chrome}>
          <span />
          <span />
          <span />
          <em>nod · Scout camping trip</em>
        </div>
        <div className={styles.windowBody}>
          <div className={styles.ask}>
            <span className={styles.spark}>✦</span>
            <span>
              Camping gear for 6 scouts, under $800 · <b>cut 20%</b>
            </span>
          </div>
          <div className={styles.sheetHead}>
            <strong>Sheet · v3</strong>
            <span className={styles.tag}>2 items changed by the agent</span>
          </div>
          <div className={styles.rows}>
            {previewRows.map((row) => (
              <div key={row.name} className={`${styles.row} ${row.changed ? styles.changed : ""}`}>
                <span>{row.name}</span>
                <span className={styles.qty}>×{row.qty}</span>
                <span className={styles.amount}>{row.total}</span>
              </div>
            ))}
          </div>
          <div className={styles.totalRow}>
            <span>Total</span>
            <strong>$564.88</strong>
          </div>
          <div className={styles.payBtn}>
            <img src={paypalLogo} alt="" /> Pay with <b>PayPal</b>
          </div>
        </div>
      </div>
      <div className={`${styles.chip} ${styles.chipNod}`}>
        <span className={styles.chipIcon}>✓</span>
        <span>
          <strong>3 of 3 nodded</strong>
          <small>v3 approved by the group</small>
        </span>
      </div>
      <div className={`${styles.chip} ${styles.chipPool}`}>
        <span>
          <strong>Community pool</strong>
          <small>$406 of $564 raised</small>
        </span>
        <span className={styles.miniBar}>
          <span style={{ width: "72%" }} />
        </span>
      </div>
    </div>
  );
}

export function HomePage() {
  const { data: user } = useMe();

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>PayPal AI Hackathon project</span>
          <h1 className={styles.title}>Your agent shops. Your nod pays.</h1>
          <p className={styles.lead}>
            Nod turns a plain-English request into a sourced, budget-aware shopping sheet. An AI agent does the
            legwork, nothing is charged until you approve an exact version, and you pay securely with PayPal.
          </p>
          <div className={styles.actions}>
            {user ? (
              <Link to="/requests" className="button primary">
                Go to my requests
              </Link>
            ) : (
              <Link to="/login" className="button primary">
                Get started
              </Link>
            )}
            <Link to="/about" className="button">
              Learn more
            </Link>
          </div>
        </div>
        <ProductPreview />
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>The flow</span>
          <h2>How it works</h2>
          <p>Four steps from a plain-English request to a paid PayPal order.</p>
        </header>
        <ol className={styles.steps}>
          {steps.map((step, i) => (
            <li key={step.title} className={styles.step}>
              <span className={styles.stepNumber}>{i + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${styles.section} ${styles.band}`}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>Why it matters</span>
          <h2>Why it’s different</h2>
          <p>The AI does the legwork, and deterministic checks keep it honest.</p>
        </header>
        <div className={styles.features}>
          {features.map((f) => (
            <div key={f.title} className={styles.feature}>
              <span className={styles.featureIcon}>{featureIcons[f.title]}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>Under the hood</span>
          <h2>What it’s built with</h2>
          <p>PayPal and AI at the core, plus a few sponsor tools.</p>
        </header>
        <ul className={styles.stack}>
          {stack.map((s) => (
            <li key={s.name}>
              {s.sponsor && <span className={styles.sponsorTag}>Sponsor</span>}
              <div className={styles.logos}>
                {s.logos.map((l) => (
                  <img key={l.alt} src={l.src} alt={l.alt} title={l.alt} />
                ))}
              </div>
              <strong>{s.name}</strong>
              <span>{s.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.kicker}>Guardrails</span>
          <h2>Design principles</h2>
          <p>Rules the app follows so the amount you approve is the amount you pay.</p>
        </header>
        <ul className={styles.principles}>
          {principles.map((p) => (
            <li key={p}>
              <span className={styles.check}>{icon("M5 12l4 4 10-10")}</span>
              <p>{p}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.note}>
        Demo only: all payments run in the PayPal Sandbox and no real money moves.
      </p>
    </div>
  );
}
