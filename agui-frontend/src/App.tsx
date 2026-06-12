import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { useMemo, useState } from 'react'
import { MessagePart } from './components/ToolPanels'
import './App.css'

const API_BASE = 'http://localhost:3000'

export default function App() {
  const chatUrl = `${API_BASE}/ai/chat`

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: chatUrl,
      }),
    [chatUrl],
  )

  const { messages, sendMessage, status, stop, error, clearError } = useChat<UIMessage>({
    transport,
  })
  const [input, setInput] = useState('')

  const busy = status === 'submitted' || status === 'streaming'
  const canSend = status === 'ready' && input.trim().length > 0
  const lastAssistant = messages.filter((m) => m.role === 'assistant').at(-1)

  return (
    <div className="chat-app">
      <header className="chat-header">
        <div>
          <h1>agui</h1>
          <p className="chat-sub">Backend: {chatUrl}</p>
        </div>
        {busy && (
          <button type="button" className="btn-stop" onClick={() => stop()}>
            Stop
          </button>
        )}
      </header>

      <div className="chat-messages" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="chat-empty">
            Type a message to start chatting
          </p>
        )}
        {messages.map((message) => {
          const textPartIndices = message.parts
            .map((p, i) => (p.type === 'text' ? i : -1))
            .filter((i) => i >= 0)
          const lastTextPartIdx = textPartIndices[textPartIndices.length - 1]

          return (
            <article
              key={message.id}
              className={`chat-bubble chat-bubble--${message.role}`}
            >
              <span className="chat-role">
                {message.role === 'user' ? 'You' : 'Assistant'}
              </span>
              <div className="chat-body">
                {message.parts.map((part, index) => (
                  <MessagePart
                    key={`${message.id}-p-${index}`}
                    part={part}
                    textStreamActive={
                      part.type === 'text' &&
                      message.role === 'assistant' &&
                      message.id === lastAssistant?.id &&
                      index === lastTextPartIdx &&
                      busy
                    }
                  />
                ))}
              </div>
            </article>
          )
        })}
      </div>

      {error && (
        <div className="chat-error" role="alert">
          <span>{error.message}</span>
          <button type="button" onClick={() => clearError()}>
            Close
          </button>
        </div>
      )}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSend) return
          void sendMessage({ text: input })
          setInput('')
        }}
      >
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) {
                void sendMessage({ text: input })
                setInput('')
              }
            }
          }}
          placeholder="Type a message, Enter to send, Shift+Enter for new line"
          rows={3}
          disabled={status !== 'ready'}
          aria-label="Message input"
        />
        <div className="chat-actions">
          <span className="chat-status">
            {status === 'ready' && 'Ready'}
            {status === 'submitted' && 'Sent...'}
            {status === 'streaming' && 'Generating...'}
            {status === 'error' && 'Error'}
          </span>
          <button type="submit" disabled={!canSend}>
            Send
          </button>
        </div>
      </form>
    </div>
  )
}