import styles from "./AboutPage.module.css";

export function AboutPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>About Us</h1>

      <div className={styles.body}>
        <p>
          <span className={styles.brand}>Nod,</span> where our goal is to make buying for a team
          effortless. Our MERN stack web application lets you <strong>describe what you need in plain English</strong>{" "}
          and have an <strong>AI agent build a sourced, budget-aware shopping sheet</strong> from real products.
        </p>
        <p>
          We believe that spending money should always stay in <span className={styles.highlight}>your control</span>,
          which is why every change is versioned, totals are checked on the server, and you approve one exact version
          before anything is charged.
        </p>
        <p>
          Our mission is to take procurement from “I need…” to a paid order in minutes. With{" "}
          <strong>PayPal</strong> handling checkout and <strong>AI</strong> doing the sourcing, we aim to make team
          purchasing <strong>fast, transparent and trustworthy for everyone.</strong>
        </p>
      </div>

      <p className={styles.madeWith}>
        Made with <span aria-label="love">💙</span> for the PayPal AI Hackathon
      </p>
    </div>
  );
}
