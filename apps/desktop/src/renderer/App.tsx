import { useEffect } from 'react';
import { BoardIcon } from './components/Icons';
import { AuthScreen } from './pages/AuthPages';
import { RoomPage } from './pages/RoomPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { useNav } from './store/nav';
import { useSession } from './store/session';

function Splash() {
  return (
    <div className="splash">
      <div className="splash-inner">
        <div className="splash-mark">
          <BoardIcon size={22} />
        </div>
        <span>正在恢复登录状态…</span>
      </div>
    </div>
  );
}

export default function App() {
  const status = useSession((s) => s.status);
  const view = useNav((s) => s.view);
  const bootstrap = useSession((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === 'booting') return <Splash />;
  if (status === 'anon') return <AuthScreen />;
  return view === 'room' ? <RoomPage /> : <WorkbenchPage />;
}
