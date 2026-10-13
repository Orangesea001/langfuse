export type SidebarNotification = {
  id: string;
  title: string;
  description: string;
  createdAt?: string;
  link?: string;
  linkTitle?: string;
  linkImage?: {
    alt: string;
    src: string;
  };
  ttlMs?: number;
};

export const SIDEBAR_NOTIFICATIONS: SidebarNotification[] = [];
