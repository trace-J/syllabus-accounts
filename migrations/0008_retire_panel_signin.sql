-- The panel's own web sign-in is gone, and so is what it stored.
--
-- Until 2026-09-15 a panel published through a Cloudflare Tunnel sent its
-- visitor here to sign in, got a one-time code back, and traded it for the
-- account (panel_codes); it registered where it was published so that the
-- code could only ever be sent back there (devices.public_url). The relay
-- replaced that road, the tunnel and its hostname were retired, and the
-- code behind it went on 2026-09-17. Nothing reads either of these now.
--
-- Both are dropped rather than left in place: public_url is an address a
-- device once answered on, which is worth not keeping, and a panel_codes
-- row is a live credential's shadow.

DROP TABLE IF EXISTS panel_codes;

ALTER TABLE devices DROP COLUMN public_url;
