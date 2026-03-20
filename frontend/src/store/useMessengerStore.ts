import { create } from 'zustand';
import { chatApi } from '@/lib/api';
import type { ChatRoom, ChatRoomMessage, BroadcastStatus } from '@/types';

interface MessengerState {
  // Rooms
  rooms: ChatRoom[];
  activeRoomId: string | null;
  loadingRooms: boolean;
  searchQuery: string;

  // Messages
  messages: ChatRoomMessage[];
  loadingMessages: boolean;
  isSending: boolean;

  // Broadcast progress
  broadcastStatus: BroadcastStatus | null;

  // Event subscription (internal, not exposed directly)
  _eventSub: { close: () => void } | null;
  _lastMsgId: string | null;

  // UI
  createModalOpen: boolean;
  inviteModalOpen: boolean;
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  memberPanelOpen: boolean;
  selectedMemberId: string | null;

  // Actions - Rooms
  fetchRooms: () => Promise<void>;
  setActiveRoom: (roomId: string | null) => Promise<void>;
  deleteRoom: (roomId: string) => Promise<void>;
  addMembersToRoom: (sessionIds: string[]) => Promise<void>;
  setSearchQuery: (q: string) => void;

  // Actions - Messages
  sendMessage: (content: string) => Promise<void>;

  // Actions - Event stream
  _subscribeToEvents: (roomId: string) => void;
  _unsubscribeEvents: () => void;

  // Actions - UI
  setCreateModalOpen: (open: boolean) => void;
  setInviteModalOpen: (open: boolean) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setMemberPanelOpen: (open: boolean) => void;
  setSelectedMemberId: (id: string | null) => void;

  // Derived
  getActiveRoom: () => ChatRoom | undefined;
  getFilteredRooms: () => ChatRoom[];
}

export const useMessengerStore = create<MessengerState>((set, get) => ({
  rooms: [],
  activeRoomId: null,
  loadingRooms: false,
  searchQuery: '',
  messages: [],
  loadingMessages: false,
  isSending: false,
  broadcastStatus: null,
  _eventSub: null,
  _lastMsgId: null,
  createModalOpen: false,
  inviteModalOpen: false,
  mobileSidebarOpen: false,
  sidebarCollapsed: false,
  memberPanelOpen: false,
  selectedMemberId: null,

  fetchRooms: async () => {
    set({ loadingRooms: true });
    try {
      const res = await chatApi.listRooms();
      set({ rooms: res.rooms });
    } catch {
      /* ignore */
    } finally {
      set({ loadingRooms: false });
    }
  },

  setActiveRoom: async (roomId) => {
    const { _unsubscribeEvents } = get();
    _unsubscribeEvents();

    if (!roomId) {
      set({ activeRoomId: null, messages: [], mobileSidebarOpen: false, broadcastStatus: null, _lastMsgId: null });
      return;
    }
    set({ activeRoomId: roomId, loadingMessages: true, mobileSidebarOpen: false, broadcastStatus: null });
    try {
      const msgsRes = await chatApi.getRoomMessages(roomId);
      const msgs = msgsRes.messages;
      const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
      set({ messages: msgs, _lastMsgId: lastId });

      // Subscribe to live events starting from the last known message
      get()._subscribeToEvents(roomId);
    } catch {
      /* ignore */
    } finally {
      set({ loadingMessages: false });
    }
  },

  deleteRoom: async (roomId) => {
    try {
      await chatApi.deleteRoom(roomId);
      const { activeRoomId, _unsubscribeEvents } = get();
      if (activeRoomId === roomId) {
        _unsubscribeEvents();
      }
      set(s => ({
        rooms: s.rooms.filter(r => r.id !== roomId),
        ...(activeRoomId === roomId ? { activeRoomId: null, messages: [], broadcastStatus: null, _lastMsgId: null } : {}),
      }));
    } catch {
      /* ignore */
    }
  },

  setSearchQuery: (q) => set({ searchQuery: q }),

  addMembersToRoom: async (sessionIds) => {
    const { activeRoomId, fetchRooms } = get();
    if (!activeRoomId || sessionIds.length === 0) return;
    const room = get().getActiveRoom();
    if (!room) return;
    const merged = [...new Set([...room.session_ids, ...sessionIds])];
    try {
      await chatApi.updateRoom(activeRoomId, { session_ids: merged });
      await fetchRooms();
    } catch {
      /* ignore */
    }
  },

  sendMessage: async (content) => {
    const { activeRoomId } = get();
    if (!activeRoomId || !content.trim()) return;

    set({ isSending: true });

    try {
      const res = await chatApi.broadcastToRoom(activeRoomId, { message: content.trim() });
      // The user_message comes back immediately from the POST response.
      // The event stream will also deliver it via 'message' event,
      // but we add it immediately to avoid delay.
      set(s => {
        const alreadyExists = s.messages.some(m => m.id === res.user_message.id);
        if (alreadyExists) return {};
        return {
          messages: [...s.messages, res.user_message],
          _lastMsgId: res.user_message.id,
        };
      });

      if (res.target_count > 0 && res.broadcast_id) {
        set({
          broadcastStatus: {
            broadcast_id: res.broadcast_id,
            total: res.target_count,
            completed: 0,
            responded: 0,
            finished: false,
          },
        });
      }

      // Refresh room list to update message counts
      get().fetchRooms();
    } catch (e: unknown) {
      set(s => ({
        messages: [...s.messages, {
          id: `err-${Date.now()}`,
          type: 'system' as const,
          content: e instanceof Error ? e.message : 'Failed to send message',
          timestamp: new Date().toISOString(),
        }],
      }));
    } finally {
      set({ isSending: false });
    }
  },

  _subscribeToEvents: (roomId: string) => {
    const { _lastMsgId, _unsubscribeEvents } = get();
    _unsubscribeEvents();

    const sub = chatApi.subscribeToRoom(roomId, _lastMsgId, (eventType, eventData) => {
      const state = get();
      // Only process events for the currently active room
      if (state.activeRoomId !== roomId) return;

      switch (eventType) {
        case 'message': {
          const msg = eventData as unknown as ChatRoomMessage;
          set(s => {
            // Deduplicate — message may already exist from POST response
            if (s.messages.some(m => m.id === msg.id)) return {};
            return {
              messages: [...s.messages, msg],
              _lastMsgId: msg.id,
            };
          });
          break;
        }
        case 'broadcast_status': {
          const status = eventData as unknown as BroadcastStatus;
          set({ broadcastStatus: status });
          break;
        }
        case 'broadcast_done': {
          set({ broadcastStatus: null });
          // Refresh room list for updated counts
          get().fetchRooms();
          break;
        }
        // heartbeat — no action needed
      }
    });

    set({ _eventSub: sub });
  },

  _unsubscribeEvents: () => {
    const { _eventSub } = get();
    if (_eventSub) {
      _eventSub.close();
      set({ _eventSub: null });
    }
  },

  setCreateModalOpen: (open) => set({ createModalOpen: open }),
  setInviteModalOpen: (open) => set({ inviteModalOpen: open }),
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  toggleSidebarCollapsed: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setMemberPanelOpen: (open) => set({ memberPanelOpen: open, ...(!open ? { selectedMemberId: null } : {}) }),
  setSelectedMemberId: (id) => set({ selectedMemberId: id, memberPanelOpen: !!id }),

  getActiveRoom: () => {
    const { rooms, activeRoomId } = get();
    return rooms.find(r => r.id === activeRoomId);
  },

  getFilteredRooms: () => {
    const { rooms, searchQuery } = get();
    if (!searchQuery.trim()) return rooms;
    const q = searchQuery.toLowerCase();
    return rooms.filter(r => r.name.toLowerCase().includes(q));
  },
}));
