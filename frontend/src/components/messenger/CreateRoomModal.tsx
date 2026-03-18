'use client';

import { useState, useCallback } from 'react';
import { useMessengerStore } from '@/store/useMessengerStore';
import { useAppStore } from '@/store/useAppStore';
import { chatApi } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { X, Bot, Loader2, Hash } from 'lucide-react';

const getRoleColor = (role: string) => {
  switch (role) {
    case 'developer': return 'from-blue-500 to-cyan-500';
    case 'researcher': return 'from-amber-500 to-orange-500';
    case 'planner': return 'from-teal-500 to-emerald-500';
    default: return 'from-emerald-500 to-green-500';
  }
};

const getRoleBadgeBg = (role: string) => {
  switch (role) {
    case 'developer': return 'linear-gradient(135deg, #3b82f6, #06b6d4)';
    case 'researcher': return 'linear-gradient(135deg, #f59e0b, #ea580c)';
    case 'planner': return 'linear-gradient(135deg, #14b8a6, #10b981)';
    default: return 'linear-gradient(135deg, #10b981, #059669)';
  }
};

export default function CreateRoomModal() {
  const { setCreateModalOpen, fetchRooms, setActiveRoom } = useMessengerStore();
  const { sessions } = useAppStore();
  const { t } = useI18n();

  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const toggle = (sid: string) => {
    setSelectedIds(prev =>
      prev.includes(sid) ? prev.filter(id => id !== sid) : [...prev, sid],
    );
  };

  const selectAll = () => {
    if (selectedIds.length === sessions.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(sessions.map(s => s.session_id));
    }
  };

  const handleCreate = useCallback(async () => {
    if (!name.trim() || selectedIds.length === 0 || creating) return;
    setCreating(true);
    try {
      const room = await chatApi.createRoom({ name: name.trim(), session_ids: selectedIds });
      await fetchRooms();
      setCreateModalOpen(false);
      setActiveRoom(room.id);
    } catch {
      /* ignore */
    } finally {
      setCreating(false);
    }
  }, [name, selectedIds, creating, fetchRooms, setCreateModalOpen, setActiveRoom]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setCreateModalOpen(false)}
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl shadow-2xl flex flex-col max-h-[85vh] animate-[scaleIn_200ms_ease-out]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--primary-color)] to-blue-600 flex items-center justify-center">
              <Hash size={14} className="text-white" />
            </div>
            <h2 className="text-[0.9375rem] font-bold text-[var(--text-primary)]">
              {t('messenger.createRoom')}
            </h2>
          </div>
          <button
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all border-none bg-transparent cursor-pointer"
            onClick={() => setCreateModalOpen(false)}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* Room name */}
          <div>
            <label className="block text-[0.75rem] font-semibold text-[var(--text-secondary)] mb-1.5 uppercase tracking-wider">
              {t('messenger.roomName')}
            </label>
            <div className="relative">
              <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                className="w-full pl-9 pr-3 py-2.5 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-color)] text-[var(--text-primary)] text-[0.8125rem] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)] transition-all"
                placeholder={t('messenger.enterRoomName')}
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          {/* Session selection */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[0.75rem] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
                {t('messenger.selectSessions')}
              </label>
              <button
                className="text-[0.6875rem] text-[var(--primary-color)] hover:underline border-none bg-transparent cursor-pointer font-medium"
                onClick={selectAll}
              >
                {selectedIds.length === sessions.length ? t('messenger.deselectAll') : t('messenger.selectAll')}
              </button>
            </div>

            {sessions.length === 0 ? (
              <p className="text-[0.8125rem] text-[var(--text-muted)] py-4 text-center">
                {t('messenger.noSessions')}
              </p>
            ) : (
              <div className="space-y-1">
                {sessions.map(s => {
                  const alive = s.status === 'running';
                  const selected = selectedIds.includes(s.session_id);
                  return (
                    <div
                      key={s.session_id}
                      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition-all ${
                        selected
                          ? 'border-[var(--primary-color)] bg-[var(--primary-subtle)]'
                          : 'border-[var(--border-color)] bg-[var(--bg-primary)] hover:border-[var(--border-subtle)]'
                      } ${!alive ? 'opacity-50' : ''}`}
                      onClick={() => toggle(s.session_id)}
                    >
                      {/* Checkbox */}
                      <div
                        className={`w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-all shrink-0 ${
                          selected
                            ? 'border-[var(--primary-color)] bg-[var(--primary-color)]'
                            : 'border-[var(--border-subtle)]'
                        }`}
                      >
                        {selected && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                            <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>

                      {/* Avatar */}
                      <div
                        className={`w-8 h-8 rounded-full bg-gradient-to-br ${getRoleColor(s.role || 'worker')} flex items-center justify-center shrink-0`}
                      >
                        <Bot size={13} className="text-white" />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <span className="text-[0.8125rem] font-medium text-[var(--text-primary)] truncate block">
                          {s.session_name || s.session_id.substring(0, 8)}
                        </span>
                      </div>

                      {/* Role badge */}
                      <span
                        className="px-1.5 py-0.5 rounded text-[0.5625rem] font-bold text-white uppercase tracking-wider shrink-0"
                        style={{ background: getRoleBadgeBg(s.role || 'worker') }}
                      >
                        {s.role || 'worker'}
                      </span>

                      {/* Status dot */}
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${
                          alive
                            ? 'bg-[var(--success-color)] shadow-[0_0_4px_var(--success-color)]'
                            : 'bg-gray-400'
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-4 border-t border-[var(--border-color)] flex items-center justify-between">
          <span className="text-[0.75rem] text-[var(--text-muted)]">
            {selectedIds.length > 0 && `${selectedIds.length} ${t('messenger.selected')}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              className="px-4 py-2 rounded-lg text-[0.8125rem] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all border-none bg-transparent cursor-pointer"
              onClick={() => setCreateModalOpen(false)}
            >
              {t('messenger.cancel')}
            </button>
            <button
              className="px-5 py-2 rounded-lg bg-[var(--primary-color)] hover:bg-[var(--primary-hover)] text-white text-[0.8125rem] font-medium cursor-pointer border-none transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
              disabled={!name.trim() || selectedIds.length === 0 || creating}
              onClick={handleCreate}
            >
              {creating && <Loader2 size={13} className="animate-spin inline mr-1.5" />}
              {t('messenger.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
