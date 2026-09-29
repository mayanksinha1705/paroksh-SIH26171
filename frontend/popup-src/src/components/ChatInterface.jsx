import { useRef, useEffect } from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '../lib/utils.js';

function TypingIndicator() {
  return (
    <div className="flex mb-3 justify-start">
      <div className="flex items-center gap-0.5 text-muted-foreground/60 text-xs">
        <div className="w-1 h-1 rounded-full bg-current animate-bounce [animation-duration:1.4s] [animation-delay:-0.16s]" />
        <div className="w-1 h-1 rounded-full bg-current animate-bounce [animation-duration:1.4s] [animation-delay:-0.32s]" />
        <div className="w-1 h-1 rounded-full bg-current animate-bounce [animation-duration:1.4s] [animation-delay:-0.48s]" />
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('mb-3 animate-slide-up flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[82%]',
          isUser
            ? 'bg-secondary rounded-lg px-3 py-2'
            : cn(
                'border rounded-lg',
                message.isError
                  ? 'border-destructive/40 bg-destructive/5'
                  : 'border-border/60 bg-secondary/20'
              )
        )}
      >
        {!isUser && (
          <div className="flex items-center gap-1.5 px-3 pt-2">
            <Sparkles className="h-3 w-3 text-blue-400" />
            <span className="text-xs font-semibold text-blue-400">PAROKSH</span>
          </div>
        )}
        <p className={cn('text-sm break-words whitespace-pre-wrap', isUser ? '' : 'px-3 pb-2 pt-1')}>
          {message.text}
        </p>
      </div>
    </div>
  );
}

export function ChatInterface({ messages, isTyping }) {
  const endRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }, [messages, isTyping]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide">
      <div className="px-3 py-3">
        {messages.map((message, index) => (
          <MessageBubble key={index} message={message} />
        ))}
        {isTyping && <TypingIndicator />}
        <div ref={endRef} />
      </div>
    </div>
  );
}
