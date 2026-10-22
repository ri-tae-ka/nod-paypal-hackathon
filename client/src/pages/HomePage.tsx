import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import heroArt from "../assets/home-illustration.svg";
import paypalLogo from "../assets/logos/paypal.svg";
import geminiLogo from "../assets/logos/googlegemini.svg";
import channel3Logo from "../assets/logos/channel3.svg";
import agGridLogo from "../assets/logos/aggrid.png";
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
    body: "Approve the exact version you reviewed, then pay with PayPal. The amount charged always matches what you approved.",
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
  { title: "PayPal checkout", body: "Pay with PayPal Orders v2 in the sandbox, with idempotent capture and amount checks." },
];

type Logo = { src: string; alt: string };

const stack: { name: string; role: string; logos: Logo[]; sponsor?: boolean }[] = [
  {
    name: "PayPal Orders v2",
    role: "Creates and captures sandbox orders for the exact approved version.",
    logos: [{ src: paypalLogo, alt: "PayPal" }],
  },
  {
    name: "Google Gemini",
    role: "Plans searches, picks products and explains each choice using structured JSON output.",
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
    role: "Shows the editable procurement sheet.",
    logos: [{ src: agGridLogo, alt: "AG Grid" }],
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
        <img src={heroArt} alt="" className={styles.heroArt} />
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
