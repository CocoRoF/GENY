'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useMessengerStore } from '@/store/useMessengerStore';
import { useAppStore } from '@/store/useAppStore';
import { useI18n } from '@/lib/i18n';
import { Send, Loader2 } from 'lucide-react';

export default function MessageInput() {
  const { isSending, sendMessage, getActiveRoom } = useMessengerStore();
  const { sessions } = useAppStore();
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const room = getActiveRoom();

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, [room?.id]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isSending || !room) return;

    const memberAgents = room.session_ids
      .map(sid => {
        const s = sessions.find(sess => sess.session_id === sid);
        return s
          ? { session_id: sid, session_name: s.session_name || sid.substring(0, 8), role: s.role || 'worker' }
          : null;
      })
      .filter(Boolean) as Array<{ session_id: string; session_name: string; role: string }>;

    sendMessage(input.trim(), memberAgents);
    setInput('');

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, isSending, room, sessions, sendMessage]);

  return (
    <div className="shrink-0 px-4 md:px-6 py-3 bg-[var(--bg-primary)] border-t border-[var(--border-color)]">
      <div className="relative flex items-end gap-2 max-w-4xl mx-auto">
        <textarea
          ref={textareaRef}
          className="flex-1 p-3 pr-12 bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl text-[var(--text-primary)] text-[0.8125rem] font-[inherit] resize-none min-h-[44px] max-h-[160px] leading-relaxed transition-all placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--primary-color)] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
          placeholder={t('messenger.inputPlaceholder')}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={1}
          disabled={isSending}
        />
        <button
          className="absolute right-2 bottom-2 w-9 h-9 rounded-lg bg-[var(--primary-color)] hover:bg-[var(--primary-hover)] text-white flex items-center justify-center cursor-pointer transition-all duration-150 border-none disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
          disabled={isSending || !input.trim()}
          onClick={handleSend}
        >
          {isSending ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Send size={15} />
          )}
        </button>
      </div>
      <div className="flex items-center mt-1.5 max-w-4xl mx-auto">
        <span className="text-[0.625rem] text-[var(--text-muted)]">
          Enter {t('messenger.sendHint')} · Shift+Enter {t('messenger.newlineHint')}
        </span>
      </div>
    </div>
  );
}
