import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuthActions, useMe } from "../hooks/useAuth";
import { NodLogo } from "./NodLogo";
import styles from "./Layout.module.css";

const navClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navLink} ${styles.active}` : styles.navLink;

export function Layout() {
  const { data: user } = useMe();
  const { logout } = useAuthActions();
  const navigate = useNavigate();

  return (
    <>
      <header className={styles.header}>
        <div className={styles.inner}>
          <div className={styles.left}>
            <Link to="/" className={styles.brand} aria-label="Nod home">
              <NodLogo className={styles.logo} />
            </Link>
            <span className={styles.sandbox}>PayPal Sandbox</span>
          </div>
          <nav className={styles.nav}>
            <NavLink to="/" end className={navClass}>
              Home
            </NavLink>
            <NavLink to="/about" className={navClass}>
              About
            </NavLink>
            {user ? (
              <>
                <NavLink to="/requests" className={navClass}>
                  My requests
                </NavLink>
                <span className={styles.userName}>{user.displayName}</span>
                <button
                  onClick={() => logout.mutate(undefined, { onSettled: () => navigate("/") })}
                  disabled={logout.isPending}
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="button primary">
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </>
  );
}
