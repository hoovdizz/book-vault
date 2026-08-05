import { api } from '@/lib/auth';
import { CatalogResponse } from '@/types/book';

export type CatalogQuery = {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string[];
  format?: string[];
  readStatus?: string[];
  owner?: string[];
  locationId?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
};

export function catalogUrl(query: CatalogQuery = {}) {
  const parameters = new URLSearchParams();
  if (query.page) parameters.set('page', String(query.page));
  if (query.pageSize) parameters.set('pageSize', String(query.pageSize));
  if (query.q?.trim()) parameters.set('q', query.q.trim());
  if (query.status?.length) parameters.set('status', query.status.join(','));
  if (query.format?.length) parameters.set('format', query.format.join(','));
  if (query.readStatus?.length) parameters.set('readStatus', query.readStatus.join(','));
  if (query.owner?.length) parameters.set('owner', query.owner.join(','));
  if (query.locationId) parameters.set('locationId', query.locationId);
  if (query.sort) parameters.set('sort', query.sort);
  if (query.direction) parameters.set('direction', query.direction);
  const suffix = parameters.toString();
  return `/api/catalog${suffix ? `?${suffix}` : ''}`;
}

export function fetchCatalog(query: CatalogQuery = {}) {
  return api<CatalogResponse>(catalogUrl(query));
}

export const catalogQueryKeys = [
  ['catalog'],
  ['catalog-stats'],
  ['catalog-duplicates'],
  ['catalog-series'],
] as const;
