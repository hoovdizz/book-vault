import type { BookBinding, BookCondition } from '@/types/book';

export interface LibrarySettings {
  defaultLocation: string;
  defaultBinding: BookBinding | '';
  defaultCondition: BookCondition | '';
  locations: string[];
  locationScope: 'personal' | 'family';
}

export interface FamilyMember {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export interface Family {
  id: string;
  name: string;
  members: FamilyMember[];
}

export interface FamilyResponse {
  family: Family | null;
  canManage: boolean;
}
