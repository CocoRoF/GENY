'use client';

import { useAppStore } from '@/store/useAppStore';
import { useI18n } from '@/lib/i18n';
import type { SessionInfo } from '@/types';
import ConfirmModal from './ConfirmModal';

interface Props { session: SessionInfo; onClose: () => void; }

export default function DeleteSessionModal({ session, onClose }: Props) {
  const { deleteSession } = useAppStore();
  const { t } = useI18n();

  return (
    <ConfirmModal
      title={t('deleteSessionModal.title')}
      message={<>{t('deleteSessionModal.confirm')}<strong className="text-[var(--text-primary)]">{session.session_name || session.session_id.substring(0, 12)}</strong>?</>}
      note={t('deleteSessionModal.softDeleteNote')}
      onConfirm={() => deleteSession(session.session_id)}
      onClose={onClose}
    />
  );
}
