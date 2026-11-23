import { Routes, Route } from 'react-router-dom';
import Landing from './pages/Landing';
import PatientDashboard from './pages/PatientDashboard';
import IssuerDashboard from './pages/IssuerDashboard';
import VerifyPage from './pages/VerifyPage';
import AdminDashboard from './pages/AdminDashboard';
import IssuerOnboarding from './pages/IssuerOnboarding';
import AnalyticsDashboard from './pages/AnalyticsDashboard';
import { AuthProvider, useFreighter } from './hooks/useFreighter';
import { useDarkMode } from './hooks/useDarkMode';
import FreighterBanner from './components/FreighterBanner';
import DemoBanner from './components/DemoBanner';
import NavBar from './components/NavBar';
import SkipToContent from './components/SkipToContent';

function AppShell() {
  const [dark, setDark] = useDarkMode();
  const { address } = useFreighter();

  return (
    <>
      <SkipToContent />
      <DemoBanner/>
      <NavBar dark={dark} onToggleDark={() => setDark(d => !d)} />
      <FreighterBanner />
      <main id="main-content" tabIndex={-1} style={{ outline: 'none' }}>
        {/* Keying on the active account remounts all wallet-dependent pages,
            clearing cached private records and pending requests on disconnect
            or account change so stale data is never shown. */}
        <Routes key={address || 'disconnected'}>
          <Route path="/" element={<Landing />} />
          <Route path="/patient" element={<PatientDashboard />} />
          <Route path="/issuer" element={<IssuerDashboard />} />
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/apply" element={<IssuerOnboarding />} />
          <Route path="/analytics" element={<AnalyticsDashboard />} />
        </Routes>
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}
