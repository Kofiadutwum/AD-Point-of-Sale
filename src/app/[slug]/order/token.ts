/** The httpOnly cookie that holds a visitor's verified-phone token for one shop (spec 6.49). */
export const orderTokenCookie = (slug: string) => `order_${slug}`;
