CREATE TABLE IF NOT EXISTS support_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subject VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_threads_customer ON support_threads(customer_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads(status,updated_at DESC);

DROP TRIGGER IF EXISTS trg_support_threads_updated_at ON support_threads;
CREATE TRIGGER trg_support_threads_updated_at BEFORE UPDATE ON support_threads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender_type VARCHAR(20) NOT NULL CHECK (sender_type IN ('customer','staff')),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  message VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (sender_type='customer' AND customer_id IS NOT NULL AND staff_id IS NULL)
    OR
    (sender_type='staff' AND staff_id IS NOT NULL AND customer_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id,created_at);
