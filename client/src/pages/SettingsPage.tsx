import React from 'react';
import { useAuth } from '../context/AuthContext';
import { User, Mail, Calendar, LogOut, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export const SettingsPage: React.FC = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div className="pb-6 border-b border-zinc-800">
        <h1 className="text-2xl font-black text-slate-100">Account Settings</h1>
        <p className="text-xs text-zinc-400 mt-0.5">
          Manage your CineTrack profile and session security
        </p>
      </div>

      {/* Profile Card */}
      <div className="p-6 rounded-3xl bg-[#121622] border border-zinc-800 space-y-6">
        <h2 className="text-sm font-bold text-zinc-300 uppercase tracking-wider flex items-center gap-2">
          <User className="w-4 h-4 text-red-500" />
          <span>Profile Information</span>
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Username
            </span>
            <div className="text-sm font-semibold text-slate-100">
              @{user?.username}
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 space-y-1">
            <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Email Address
            </span>
            <div className="text-sm font-semibold text-slate-100">
              {user?.email}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 text-xs text-zinc-400">
          <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
          <span>
            Protected with Argon2id cryptographic password hashing and HttpOnly JWT cookie sessions.
          </span>
        </div>

        {/* Sign Out Action */}
        <div className="pt-4 border-t border-zinc-800 flex justify-end">
          <button
            type="button"
            onClick={handleLogout}
            className="px-5 py-2.5 rounded-xl bg-red-600/10 hover:bg-red-600/20 text-red-400 border border-red-500/30 text-xs font-semibold flex items-center gap-2 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out of CineTrack</span>
          </button>
        </div>
      </div>
    </div>
  );
};
