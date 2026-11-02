import { useEffect, useState } from 'react';
import { ROLE_LABEL } from '@classroom/shared';
import { Avatar } from '../components/Avatar';
import { DeviceCheck } from '../components/DeviceCheck';
import {
  BellIcon,
  BoardIcon,
  ChatIcon,
  HandIcon,
  LogoutIcon,
  MenuIcon,
  ShieldIcon,
  UserIcon,
  UsersIcon,
  VideoIcon,
} from '../components/Icons';
import { useNav, type View } from '../store/nav';
import { useNotify } from '../store/notify';
import { useSession } from '../store/session';
import { AdminPage } from './workbench/AdminPage';
import { AssignmentsPage } from './workbench/AssignmentsPage';
import { ClassroomsPage } from './workbench/ClassroomsPage';
import { CourseDetailPage } from './workbench/CourseDetailPage';
import { CoursesPage } from './workbench/CoursesPage';
import { DashboardPage } from './workbench/DashboardPage';
import { NotificationsPage } from './workbench/NotificationsPage';
import { ProfilePage } from './workbench/ProfilePage';
import { SchedulePage } from './workbench/SchedulePage';

function NavItem({
  active,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  onClick(): void;
}) {
  return (
    <button className="wb-nav-item" data-active={active} onClick={onClick}>
      <span className="wb-nav-icon">{icon}</span>
      <span className="wb-nav-label">{label}</span>
      {badge !== undefined && badge > 0 && <span className="wb-nav-badge">{badge > 99 ? '99+' : badge}</span>}
    </button>
  );
}

function MobileNavItem({
  active,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  onClick(): void;
}) {
  return (
    <button className="m-nav-item" data-active={active} onClick={onClick}>
      <span className="m-nav-icon">
        {icon}
        {badge !== undefined && badge > 0 && <span className="m-nav-dot" />}
      </span>
      <span>{label}</span>
    </button>
  );
}

const VIEW_TITLE: Record<Exclude<View, 'room'>, string> = {
  dashboard: '工作台',
  lobby: '我的课堂',
  courses: '课程',
  course: '课程详情',
  schedule: '课表',
  assignments: '作业',
  notifications: '通知',
  admin: '管理后台',
  profile: '个人中心',
};

export function WorkbenchPage() {
  const view = useNav((s) => s.view);
  const go = useNav((s) => s.go);
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const unread = useNotify((s) => s.unread);
  const refreshUnread = useNotify((s) => s.refresh);

  const [deviceOpen, setDeviceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => void refreshUnread(), 30_000);
    return () => clearInterval(t);
  }, [refreshUnread]);

  useEffect(() => {
    void refreshUnread();
  }, [view, refreshUnread]);

  useEffect(() => {
    setMenuOpen(false);
  }, [view]);

  if (!user) return null;

  const title = view === 'room' ? '课堂' : VIEW_TITLE[view];
  const navigate = (next: Exclude<View, 'room'>): void => {
    setMenuOpen(false);
    go(next);
  };

  return (
    <div className="wb">
      <header className="m-topbar">
        <button className="m-topbar-btn" aria-label="打开菜单" onClick={() => setMenuOpen(true)}>
          <MenuIcon size={20} />
        </button>
        <div className="m-topbar-title">{title}</div>
        <button className="m-topbar-btn" aria-label="通知" onClick={() => navigate('notifications')}>
          <BellIcon size={19} />
          {unread > 0 && <span className="m-topbar-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      </header>

      {menuOpen && <button className="m-drawer-mask" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}

      <aside className="wb-side" data-open={menuOpen}>
        <div className="wb-brand">
          <div className="brand-mark" style={{ width: 30, height: 30, borderRadius: 9 }}>
            <BoardIcon size={17} />
          </div>
          <div>
            <div className="brand-name" style={{ fontSize: 15 }}>
              ClassRoom
            </div>
            <div className="brand-sub">在线教学平台</div>
          </div>
        </div>

        <nav className="wb-nav">
          <div className="wb-nav-group">教学</div>
          <NavItem active={view === 'dashboard'} icon={<BoardIcon size={16} />} label="工作台" onClick={() => navigate('dashboard')} />
          <NavItem active={view === 'lobby'} icon={<VideoIcon size={16} />} label="我的课堂" onClick={() => navigate('lobby')} />
          <NavItem active={view === 'courses' || view === 'course'} icon={<UsersIcon size={16} />} label="课程" onClick={() => navigate('courses')} />
          <NavItem active={view === 'schedule'} icon={<HandIcon size={16} />} label="课表" onClick={() => navigate('schedule')} />
          <NavItem active={view === 'assignments'} icon={<ChatIcon size={16} />} label="作业" onClick={() => navigate('assignments')} />
          <NavItem active={view === 'notifications'} icon={<ChatIcon size={16} />} label="通知" badge={unread} onClick={() => navigate('notifications')} />

          <div className="wb-nav-group">账号</div>
          <NavItem active={view === 'profile'} icon={<UsersIcon size={16} />} label="个人中心" onClick={() => navigate('profile')} />
          {user.role === 'admin' && (
            <NavItem active={view === 'admin'} icon={<ShieldIcon size={16} />} label="管理后台" onClick={() => navigate('admin')} />
          )}
          <button
            className="wb-nav-item"
            onClick={() => {
              setMenuOpen(false);
              setDeviceOpen(true);
            }}
          >
            <span className="wb-nav-icon">
              <VideoIcon size={16} />
            </span>
            <span className="wb-nav-label">设备自检</span>
          </button>
        </nav>

        <div className="wb-user">
          <Avatar name={user.displayName} size={34} />
          <div className="wb-user-main">
            <div className="wb-user-name">{user.displayName}</div>
            <div className="wb-user-role">{ROLE_LABEL[user.role]}</div>
          </div>
          <button className="icon-btn" title="退出登录" onClick={() => void logout()}>
            <LogoutIcon size={16} />
          </button>
        </div>
      </aside>

      <main className="wb-main">
        {view === 'dashboard' && <DashboardPage />}
        {view === 'lobby' && <ClassroomsPage />}
        {view === 'courses' && <CoursesPage />}
        {view === 'course' && <CourseDetailPage />}
        {view === 'schedule' && <SchedulePage />}
        {view === 'assignments' && <AssignmentsPage />}
        {view === 'notifications' && <NotificationsPage />}
        {view === 'admin' && <AdminPage />}
        {view === 'profile' && <ProfilePage />}
      </main>

      <nav className="m-nav">
        <MobileNavItem
          active={view === 'dashboard'}
          icon={<BoardIcon size={20} />}
          label="工作台"
          onClick={() => navigate('dashboard')}
        />
        <MobileNavItem
          active={view === 'lobby'}
          icon={<VideoIcon size={20} />}
          label="课堂"
          onClick={() => navigate('lobby')}
        />
        <MobileNavItem
          active={view === 'courses' || view === 'course'}
          icon={<UsersIcon size={20} />}
          label="课程"
          onClick={() => navigate('courses')}
        />
        <MobileNavItem
          active={view === 'assignments'}
          icon={<ChatIcon size={20} />}
          label="作业"
          onClick={() => navigate('assignments')}
        />
        <MobileNavItem
          active={view === 'profile'}
          icon={<UserIcon size={20} />}
          label="我的"
          onClick={() => navigate('profile')}
        />
      </nav>

      {deviceOpen && <DeviceCheck onClose={() => setDeviceOpen(false)} />}
    </div>
  );
}
