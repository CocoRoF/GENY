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

  const hasInput = input.trim().length > 0;

  return (
    <div className="shrink-0 bg-[var(--bg-secondary)]">
      <div className="h-px bg-[var(--border-color)]" />
      <div className="flex items-center gap-3 px-5 md:px-6 py-3">
        <textarea
          ref={textareaRef}
          className="messenger-input flex-1 bg-transparent text-[var(--text-primary)] text-[0.8125rem] font-[inherit] resize-none min-h-[24px] max-h-[160px] leading-relaxed placeholder:text-[var(--text-muted)] border-none py-0.5"
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
          className={`messenger-input shrink-0 w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-all duration-150 border-none disabled:cursor-not-allowed ${
            hasInput && !isSending
              ? 'bg-[var(--primary-color)] hover:bg-[var(--primary-hover)] text-white shadow-sm'
              : 'bg-transparent text-[var(--text-muted)] opacity-30'
          }`}
          disabled={isSending || !hasInput}
          onClick={handleSend}
        >
          {isSending ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Send size={15} />
          )}
        </button>
      </div>
      <div className="px-5 md:px-6 pb-2 -mt-1">
        <span className="text-[0.6125rem] text-[var(--text-muted)] opacity-40">
          Enter {t('messenger.sendHint')} · Shift+Enter {t('messenger.newlineHint')}
        </span>
      </div>
    </div>
  );
}
