import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import GridPage from "./pages/GridPage";
import DetailPage from "./pages/DetailPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  return (
    <BrowserRouter basename="/dashboard">
      <div className="app-header">
        <div className="brand">
          <Link to="/" style={{ textDecoration: "none", color: "inherit" }}>
            <h1>FACTORY VISION DASHBOARD</h1>
          </Link>
        </div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </div>
      <Routes>
        <Route path="/" element={<GridPage />} />
        <Route path="/vision/:line/:visionName" element={<DetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
