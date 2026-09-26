import { z } from 'zod';

export const CompanyInput = z.object({
  company_code: z.string().min(1),
  company_name: z.string().min(1),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().default('India'),
  has_gst: z.boolean().default(false),
  gstin: z.string().nullable().optional(),
  pan_number: z.string().nullable().optional(),
  has_table_management: z.boolean().default(true),
  has_item_variants: z.boolean().default(false),
  show_item_images: z.boolean().default(true),
});

export const OwnerInput = z.object({
  owner_name: z.string().nullable().optional(),
  owner_email: z.string().nullable().optional(),
  owner_phone: z.string().nullable().optional(),
});

export const RequestRegistrationBody = z.object({ company: CompanyInput, owner: OwnerInput });
export const VerifyOtpBody = z.object({ code: z.string().min(4).max(10) });
