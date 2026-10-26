import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { AboutPage } from "./pages/AboutPage";
import { CheckoutReturnPage } from "./pages/CheckoutReturnPage";
import { HomePage } from "./pages/HomePage";
import { JoinPage } from "./pages/JoinPage";
import { LoginPage } from "./pages/LoginPage";
import { NewRequestPage } from "./pages/NewRequestPage";
import { PoolPage } from "./pages/PoolPage";
import { PoolReturnPage } from "./pages/PoolReturnPage";
import { RequestPage } from "./pages/RequestPage";
import { RequestsPage } from "./pages/RequestsPage";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/pool/:token" element={<PoolPage />} />
        <Route path="/pool/:token/return" element={<PoolReturnPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/requests/new" element={<NewRequestPage />} />
          <Route path="/join/:token" element={<JoinPage />} />
          <Route path="/requests/:id" element={<RequestPage />} />
          <Route path="/requests/:id/checkout/return" element={<CheckoutReturnPage />} />
          <Route path="/requests/:id/checkout/cancel" element={<CheckoutReturnPage cancelled />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
