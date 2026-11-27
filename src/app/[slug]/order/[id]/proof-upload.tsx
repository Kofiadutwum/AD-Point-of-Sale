'use client';
import { PhotoUpload } from '@/components/photo-upload';
import { PROOF_TARGET } from '@/lib/images';
import { uploadProofPhotoAction } from '../actions';

/** Spec 6.49: the transfer screenshot is shrunk on the phone to at most about 200 KB, still sharp enough to read the reference. */
export function ProofUpload({ slug, orderId, label }: { slug: string; orderId: string; label: string }) {
  return <PhotoUpload upload={uploadProofPhotoAction.bind(null, slug, orderId)} target={PROOF_TARGET} label={label} />;
}
