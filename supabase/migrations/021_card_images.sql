-- ============================================================
-- 021_card_images.sql
-- Card image upload support for gift card trades
-- Run in Supabase SQL Editor
-- ============================================================

-- ── 1. Add image path column to trades ──────────────────────────────────────
ALTER TABLE trades ADD COLUMN IF NOT EXISTS card_image_path TEXT;

-- ── 2. Create private Supabase Storage bucket ────────────────────────────────
-- Images stored under {userId}/{timestamp}.{ext}
-- Private bucket — only signed URLs can be shared with vendors
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'card-images',
  'card-images',
  false,
  5242880,  -- 5 MB max per image
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png',
    'image/webp', 'image/heic', 'image/heif'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── 3. Storage RLS policies ───────────────────────────────────────────────────

-- Users can upload their own images (path must start with their user ID)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_upload'
  ) THEN
    CREATE POLICY "card_images_upload"
      ON storage.objects FOR INSERT
      WITH CHECK (
        bucket_id = 'card-images'
        AND auth.role() = 'authenticated'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- Users can view their own uploaded images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_read_own'
  ) THEN
    CREATE POLICY "card_images_read_own"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'card-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;

-- Admins can view all card images
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_read_admin'
  ) THEN
    CREATE POLICY "card_images_read_admin"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'card-images'
        AND EXISTS (
          SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'
        )
      );
  END IF;
END $$;

-- Users can delete their own images (e.g. resubmit)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'objects' AND schemaname = 'storage'
    AND policyname = 'card_images_delete_own'
  ) THEN
    CREATE POLICY "card_images_delete_own"
      ON storage.objects FOR DELETE
      USING (
        bucket_id = 'card-images'
        AND (storage.foldername(name))[1] = auth.uid()::text
      );
  END IF;
END $$;
