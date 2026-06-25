-- Regulatory cleanup: null card credentials on terminal trades (NDPR compliance).
-- card_code and card_pin are no longer needed after a trade reaches a terminal
-- state and their retention creates unnecessary data liability.

-- Null out card credentials on trades already in terminal states
UPDATE trades
SET card_code = NULL, card_pin = NULL
WHERE status IN ('paid', 'failed', 'invalid')
  AND (card_code IS NOT NULL OR card_pin IS NOT NULL);

-- Null out card credentials on vendor assignments already in terminal states
UPDATE vendor_card_assignments
SET card_code = NULL, card_pin = NULL
WHERE status IN ('redeemed', 'failed')
  AND (card_code IS NOT NULL OR card_pin IS NOT NULL);
