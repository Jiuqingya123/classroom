import { useEffect, useRef, useState } from 'react';
import type { ChatMessageDTO } from '@classroom/shared';
import { Avatar } from '../components/Avatar';
import { SendIcon } from '../components/Icons';
import { formatClock } from '../lib/format';

interface Props {
  messages: ChatMessageDTO[];
  selfId: string | null;
  target: { userId: string; displayName: string } | null;
  onClearTarget(): void;
  onSend(text: string): Promise<boolean>;
}

export function ChatPanel({ messages, selfId, target, onClearTarget, onSend }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, target]);

  const submit = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    const ok = await onSend(content);
    setSending(false);
    if (ok) setText('');
  };

  return (
    <>
      <div className="sidebar-body" ref={listRef}>
        {messages.length === 0 ? (
          <div className="pitem-sub" style={{ padding: '12px 8px' }}>
            课堂聊天记录会保存在服务器，重新进入也能看到。老师可以和学生私聊。
          </div>
        ) : (
          <div className="chat-list">
            {messages.map((m) => (
              <div className="chat-item" key={m.id}>
                <Avatar name={m.displayName} size={26} />
                <div className="chat-body">
                  <div className="chat-meta">
                    <span className="chat-name">
                      {m.displayName}
                      {m.userId === selfId ? '（我）' : ''}
                    </span>
                    {m.toUserId && <span className="chat-private">私聊</span>}
                    <span>{formatClock(m.createdAt)}</span>
                  </div>
                  <div className="chat-text">{m.content}</div>
                  {m.toName && (
                    <div className="chat-private-hint">
                      {m.userId === selfId ? `发给 ${m.toName}` : `${m.displayName} 私聊你`}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {target && (
        <div className="chat-target">
          <span>私聊 {target.displayName}</span>
          <button className="icon-btn" onClick={onClearTarget} title="取消私聊">
            ✕
          </button>
        </div>
      )}

      <div className="chat-input-row">
        <input
          className="chat-input"
          value={text}
          maxLength={500}
          placeholder={target ? `私聊 ${target.displayName}…` : '发消息…（Enter 发送）'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="chat-send" onClick={() => void submit()} disabled={!text.trim() || sending}>
          <SendIcon size={16} />
        </button>
      </div>
    </>
  );
}
