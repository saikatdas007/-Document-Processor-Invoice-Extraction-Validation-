'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

type AuthSession = {
  email: string;
  role: 'admin' | 'viewer';
  csrfToken: string;
};

type AnalyticsStats = {
  total_processed: number;
  success_rate: number;
  failed_count: number;
  avg_latency: string;
  weekly_volume: Array<{ date: string; day: string; count: number }>;
};

type DocumentResult = {
  doc_id?: string;
  customer_name?: string | null;
  invoice_number?: string | null;
  subtotal?: number | null;
  total?: number | null;
  validation_status?: string | null;
  status?: string | null;
  structured_data?: {
    customer_name?: string | null;
    invoice_number?: string | null;
    subtotal?: number | null;
    total?: number | null;
  };
};

type SemanticSearchResult = {
  doc_id: string;
  score: number;
  customer_name: string | null;
  invoice_number: string | null;
  subtotal: number | null;
  total: number | null;
  validation_status: string | null;
};

function customerNameMatchesQuery(customerName: string | null, query: string): boolean {
  if (!customerName) return false;

  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^\w]+/g, ' ').trim().replace(/\s+/g, ' ');
  const normalizedName = normalize(customerName);
  const normalizedQuery = normalize(query);

  return Boolean(
    normalizedName &&
    normalizedQuery &&
    (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName))
  );
}

function csrfHeaders(token: string): Record<string, string> {
  return token ? { 'X-CSRF-Token': token } : {};
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '$0.00';
  }
  return `$${Number(value).toFixed(2)}`;
}

export default function Dashboard() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [documents, setDocuments] = useState<DocumentResult[]>([]);
  const [failedHistoryCleared, setFailedHistoryCleared] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadLoading, setUploadLoading] = useState(false);
  const [analytics, setAnalytics] = useState<AnalyticsStats>({
    total_processed: 0,
    success_rate: 100,
    failed_count: 0,
    avg_latency: '0.0s',
    weekly_volume: [],
  });
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticResults, setSemanticResults] = useState<SemanticSearchResult[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState('');
  const [semanticHasSearched, setSemanticHasSearched] = useState(false);

  useEffect(() => {
    let active = true;
    window.sessionStorage.removeItem('document-processor-session');
    const restoreSession = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
          credentials: 'include',
        });
        if (response.status === 401) return;
        if (!response.ok) {
          throw new Error('Unable to verify your sign-in session.');
        }

        const data = await response.json();
        if (
          typeof data.email !== 'string' ||
          (data.role !== 'admin' && data.role !== 'viewer') ||
          typeof data.csrf_token !== 'string'
        ) {
          throw new Error('The server returned an invalid session.');
        }
        if (active) {
          setSession({
            email: data.email,
            role: data.role,
            csrfToken: data.csrf_token,
          });
        }
      } catch (error) {
        if (active) {
          setLoginError(error instanceof Error ? error.message : 'Unable to reach the sign-in service.');
        }
      } finally {
        if (active) setSessionLoading(false);
      }
    };

    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  const fetchDocuments = useCallback(async (query: string) => {
    const params = query ? `?customer=${encodeURIComponent(query)}` : '';

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/search${params}`, {
        credentials: 'include',
      });

      if (response.status === 401) {
        setSession(null);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to load documents.');
      }

      const data = await response.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      setDocuments(results);
    } catch (error) {
      console.error('fetchDocuments error:', error);
      setDocuments([]);
    }
  }, []);

  const fetchAnalytics = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/analytics`, {
        credentials: 'include',
      });

      if (response.status === 401) {
        setSession(null);
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to load analytics.');
      }

      const data = await response.json();
      setAnalytics(data);
    } catch (error) {
      console.error('fetchAnalytics error:', error);
    }
  }, []);

  useEffect(() => {
    if (!session) return;

    let active = true;
    const loadDashboard = async () => {
      await Promise.resolve();
      if (!active) return;

      await Promise.all([
        fetchDocuments(''),
        fetchAnalytics(),
      ]);
    };
    void loadDashboard();

    return () => {
      active = false;
    };
  }, [fetchAnalytics, fetchDocuments, session]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginError('');
    if (authMode === 'register' && password !== passwordConfirmation) {
      setLoginError('Your passwords do not match.');
      return;
    }
    setLoginLoading(true);

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/auth/${authMode === 'register' ? 'register' : 'login'}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof data?.detail === 'string'
            ? data.detail
            : `Unable to ${authMode === 'register' ? 'create your account' : 'sign in'}.`,
        );
      }

      if (
        typeof data.email !== 'string' ||
        (data.role !== 'admin' && data.role !== 'viewer') ||
        typeof data.csrf_token !== 'string'
      ) {
        throw new Error('The server returned an invalid account response.');
      }

      setSession({
        email: data.email,
        role: data.role,
        csrfToken: data.csrf_token,
      });
      setPassword('');
      setPasswordConfirmation('');
    } catch (error) {
      setLoginError(
        error instanceof Error
          ? error.message
          : `Unable to ${authMode === 'register' ? 'create your account' : 'sign in'}.`,
      );
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    setLogoutError('');
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeaders(session?.csrfToken ?? ''),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data?.detail || 'Unable to sign out.');
      }
      setSession(null);
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : 'Unable to sign out.');
    }
    setDocuments([]);
    setSemanticResults([]);
    setSemanticQuery('');
    setSemanticError('');
    setSemanticHasSearched(false);
    setSelectedFile(null);
    setUploadStatus('');
    setLoginError('');
  };

  const handleSearch = async () => {
    if (!session) return;
    await fetchDocuments(searchQuery.trim());
  };

  const handleSemanticSearch = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || !semanticQuery.trim()) return;

    setSemanticLoading(true);
    setSemanticError('');
    setSemanticResults([]);
    setSemanticHasSearched(false);

    try {
      const response = await fetch(`${API_BASE_URL}/api/documents/semantic-search`, {
        method: 'POST',
        headers: {
          ...csrfHeaders(session.csrfToken),
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ query: semanticQuery.trim(), top_k: 5 }),
      });

      const data = await response.json();
      if (response.status === 401) {
        setSession(null);
        return;
      }
      if (!response.ok) {
        throw new Error(data?.detail || 'Semantic search failed.');
      }

      setSemanticResults(Array.isArray(data?.results) ? data.results : []);
      setSemanticHasSearched(true);
    } catch (error) {
      setSemanticError(error instanceof Error ? error.message : 'Semantic search failed.');
    } finally {
      setSemanticLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!session || !selectedFile) return;

    setUploadLoading(true);
    setUploadStatus('');

    try {
      const form = new FormData();
      form.append('file', selectedFile);

      const response = await fetch(`${API_BASE_URL}/process`, {
        method: 'POST',
        headers: {
          ...csrfHeaders(session.csrfToken),
        },
        credentials: 'include',
        body: form,
      });

      const data = await response.json();
      if (response.status === 401) {
        setSession(null);
        return;
      }
      if (!response.ok) {
        throw new Error(data?.detail || 'Upload failed.');
      }

      setUploadStatus('Upload successful!');
      setSelectedFile(null);
      await fetchDocuments(searchQuery.trim());
      await fetchAnalytics();
    } catch (error) {
      setUploadStatus(error instanceof Error ? error.message : 'Upload failed.');
    } finally {
      setUploadLoading(false);
    }
  };

  const weeklyTotal = analytics.weekly_volume.reduce((total, entry) => total + entry.count, 0);
  const weeklyMaximum = Math.max(1, ...analytics.weekly_volume.map((entry) => entry.count));
  const failedDocumentsCount = documents.filter(
    (document) => document.status?.toLowerCase() === 'failed',
  ).length;

  if (sessionLoading) {
    return (
      <main className="auth-page">
        <div className="auth-loading" role="status" aria-live="polite">
          Checking your secure session…
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="auth-page">
        <div className="auth-shell">
          <section className="auth-story" aria-label="Document intelligence platform">
            <Link className="auth-brand" href="/" aria-label="AI-Powered Document Intelligence home">
              <span className="auth-brand-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M7 3.75h7l4 4v12.5H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" />
                  <path d="M14 3.75v4h4M8.5 12h7M8.5 15.5h7" />
                </svg>
              </span>
              <span className="auth-brand-name">AI-Powered<br /><span className="auth-brand-light">Document Intelligence</span></span>
            </Link>

            <div className="auth-story-copy">
              <span className="auth-kicker"><span /> YOUR DOCUMENTS, IN FOCUS</span>
              <h1>Less paperwork.<br />More <span>possibility.</span></h1>
              <p>Turn complex documents into clear, actionable insights. Your entire workflow, in one intelligent workspace.</p>
            </div>

            <div className="auth-preview" aria-hidden="true">
              <div className="auth-preview-heading">
                <span className="auth-preview-icon">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M7 3.75h7l4 4v12.5H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" />
                    <path d="M14 3.75v4h4M8.5 12h7M8.5 15.5h4" />
                  </svg>
                </span>
                <span><strong>Invoice preview</strong><small>Sample extraction</small></span>
                <span className="auth-preview-status"><span /> Ready</span>
              </div>
              <div className="auth-preview-data">
                <div><span>Sample vendor</span><strong>Northstar Supplies</strong></div>
                <div><span>Example total</span><strong>$12,480.00</strong></div>
              </div>
              <div className="auth-preview-footer">
                <span className="auth-preview-check">✓</span>
                <span>Key details organized and ready to review</span>
                <span className="auth-preview-sparkline"><i /><i /><i /><i /><i /><i /><i /></span>
              </div>
            </div>

            <div className="auth-story-footer">
              <span>BUILT FOR CLARITY</span>
              <span className="auth-footer-dot" />
              <span>DESIGNED FOR TEAMS</span>
            </div>
          </section>

          <section className="auth-panel" aria-labelledby="auth-heading">
            <Link className="auth-brand auth-mobile-brand" href="/" aria-label="AI-Powered Document Intelligence home">
              <span className="auth-brand-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M7 3.75h7l4 4v12.5H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" />
                  <path d="M14 3.75v4h4M8.5 12h7M8.5 15.5h7" />
                </svg>
              </span>
              <span className="auth-brand-name">AI-Powered<br /><span className="auth-brand-light">Document Intelligence</span></span>
            </Link>

            <div className="auth-panel-content">
              <div className="auth-panel-topline">
                <span className="auth-secure-badge">
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M10 2.5 4 5v4.6c0 3.6 2.5 6.7 6 7.9 3.5-1.2 6-4.3 6-7.9V5l-6-2.5Z" />
                    <path d="m7.5 9.8 1.7 1.7 3.6-3.7" />
                  </svg>
                  SECURE WORKSPACE
                </span>
                <span className="auth-step-indicator"><i /> {authMode === 'login' ? 'SIGN IN' : 'CREATE ACCOUNT'}</span>
              </div>

              <div className="auth-heading">
                <h2 id="auth-heading">
                  {authMode === 'login' ? <>Welcome back<span>.</span></> : <>Create your account<span>.</span></>}
                </h2>
                <p>
                  {authMode === 'login'
                    ? 'Sign in to pick up right where you left off.'
                    : 'Create a secure account to access your document workspace.'}
                </p>
              </div>

              <form className="auth-form" onSubmit={handleLogin}>
                <div className="auth-field">
                  <label htmlFor="auth-email">Email address</label>
                  <div className="auth-input-wrap">
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <rect x="2.5" y="4" width="15" height="12" rx="2" />
                      <path d="m3.5 5.5 6.5 5 6.5-5" />
                    </svg>
                    <input
                      id="auth-email"
                      type="email"
                      autoComplete="username"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <div className="auth-label-row">
                    <label htmlFor="auth-password">Password</label>
                    <span>YOUR ACCOUNT PASSWORD</span>
                  </div>
                  <div className="auth-input-wrap">
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <rect x="3.5" y="8.5" width="13" height="9" rx="2" />
                      <path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5M10 12v2" />
                    </svg>
                    <input
                      id="auth-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                      minLength={authMode === 'register' ? 12 : undefined}
                      maxLength={128}
                      placeholder={authMode === 'register' ? 'Create a strong password' : 'Enter your password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                    />
                    <button
                      className="auth-password-toggle"
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? 'HIDE' : 'SHOW'}
                    </button>
                  </div>
                </div>

                {authMode === 'register' && (
                  <>
                    <p className="auth-password-hint">Use at least 12 characters. Longer passphrases work well.</p>
                    <div className="auth-field">
                      <label htmlFor="auth-password-confirmation">Confirm password</label>
                      <div className="auth-input-wrap">
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                          <rect x="3.5" y="8.5" width="13" height="9" rx="2" />
                          <path d="M6.5 8.5V6a3.5 3.5 0 0 1 7 0v2.5M8 12.5l1.4 1.4 2.8-3" />
                        </svg>
                        <input
                          id="auth-password-confirmation"
                          type="password"
                          autoComplete="new-password"
                          maxLength={128}
                          placeholder="Enter your password again"
                          value={passwordConfirmation}
                          onChange={(event) => setPasswordConfirmation(event.target.value)}
                          required
                        />
                      </div>
                    </div>
                  </>
                )}

                {loginError && (
                  <div className="auth-error" role="alert">
                    <span aria-hidden="true">!</span>
                    {loginError}
                  </div>
                )}

                <button className="auth-submit" type="submit" disabled={loginLoading}>
                  <span>
                    {loginLoading
                      ? authMode === 'register' ? 'Creating account...' : 'Signing in...'
                      : authMode === 'register' ? 'Create secure account' : 'Sign in to your workspace'}
                  </span>
                  {!loginLoading && <span className="auth-submit-arrow" aria-hidden="true">→</span>}
                  {loginLoading && <span className="auth-submit-spinner" aria-hidden="true" />}
                </button>
              </form>

              <div className="auth-divider"><span /> <span>{authMode === 'register' ? 'ALREADY HAVE AN ACCOUNT?' : 'PRIVATE BY DESIGN'}</span> <span /></div>

              <button
                className="auth-mode-toggle"
                type="button"
                onClick={() => {
                  setAuthMode((mode) => mode === 'login' ? 'register' : 'login');
                  setLoginError('');
                  setPassword('');
                  setPasswordConfirmation('');
                }}
              >
                {authMode === 'login' ? 'Create a new account' : 'Back to sign in'}
              </button>

              <div className="auth-privacy">
                <span className="auth-privacy-icon" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none">
                    <path d="M10 2.5 4 5v4.6c0 3.6 2.5 6.7 6 7.9 3.5-1.2 6-4.3 6-7.9V5l-6-2.5Z" />
                    <path d="m7.5 9.8 1.7 1.7 3.6-3.7" />
                  </svg>
                </span>
                <span>
                  <strong>{authMode === 'register' ? 'New accounts start with viewer access.' : 'Your workspace stays yours.'}</strong>
                  <small>
                    {authMode === 'register'
                      ? 'An administrator can enable document processing permissions.'
                      : 'Your documents are protected with secure access controls.'}
                  </small>
                </span>
              </div>
            </div>

            <footer className="auth-panel-footer">
              <span>© AI-Powered Document Intelligence</span>
              <span className="auth-footer-dot" />
              <span>Secure access</span>
            </footer>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main style={{ minHeight: '100vh', background: '#020817', color: '#f8fafc', fontFamily: 'sans-serif', padding: 'clamp(16px, 4vw, 32px)' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, marginBottom: 28, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 800 }}>AI-Powered Document Intelligence</h1>
            <p style={{ margin: '8px 0 0', color: '#94a3b8', fontSize: 14 }}>Real-time intelligence and document workflows</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontWeight: 700 }}>{session.email}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', textTransform: 'uppercase' }}>{session.role}</div>
            </div>
            <button onClick={handleLogout} style={{ border: '1px solid #334155', background: '#0f172a', color: '#e2e8f0', borderRadius: 10, padding: '10px 14px', fontWeight: 600, cursor: 'pointer' }}>
              Sign out
            </button>
          </div>
        </header>

        {logoutError && (
          <div role="alert" style={{ marginBottom: 18, color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: 10, padding: '11px 13px' }}>
            {logoutError}
          </div>
        )}

        <section style={{ background: 'linear-gradient(145deg, #111827, #0b1425)', borderRadius: 18, border: '1px solid #263449', padding: 24, marginBottom: 24, boxShadow: '0 18px 45px rgba(2, 8, 23, 0.22)' }}>
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <h2 style={{ margin: 0, fontSize: 22 }}>Find an invoice</h2>
              <span style={{ border: '1px solid #1e3a5f', borderRadius: 999, padding: '3px 8px', color: '#93c5fd', background: 'rgba(37,99,235,0.12)', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em' }}>SEMANTIC SEARCH</span>
            </div>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: 14 }}>
              Search by customer name, invoice number, supplier, or billing details.
            </p>
          </div>
          <form onSubmit={handleSemanticSearch} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              value={semanticQuery}
              onChange={(event) => {
                setSemanticQuery(event.target.value);
                setSemanticResults([]);
                setSemanticError('');
                setSemanticHasSearched(false);
              }}
              aria-label="Search invoices"
              placeholder="Try a customer name, e.g. Aaron Hawkins"
              style={{ flex: 1, minWidth: 240, padding: '13px 15px', borderRadius: 11, border: '1px solid #334155', background: '#020817', color: '#f8fafc', outlineColor: '#60a5fa', fontSize: 14 }}
            />
            {semanticQuery && (
              <button
                type="button"
                onClick={() => {
                  setSemanticQuery('');
                  setSemanticResults([]);
                  setSemanticError('');
                  setSemanticHasSearched(false);
                }}
                style={{ padding: '12px 14px', background: '#0f172a', color: '#cbd5e1', border: '1px solid #334155', borderRadius: 11, fontWeight: 600, cursor: 'pointer' }}
              >
                Clear
              </button>
            )}
            <button type="submit" disabled={semanticLoading || !semanticQuery.trim()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, minWidth: 112, padding: '12px 18px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 11, fontWeight: 700, cursor: semanticLoading || !semanticQuery.trim() ? 'not-allowed' : 'pointer', opacity: semanticLoading || !semanticQuery.trim() ? 0.7 : 1 }}>
              {semanticLoading && <span className="search-spinner" aria-hidden="true" />}
              {semanticLoading ? 'Searching' : 'Search'}
            </button>
          </form>

          {semanticError && (
            <div role="alert" style={{ marginTop: 14, color: '#fca5a5', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: 10, padding: '11px 13px' }}>
              {semanticError}
            </div>
          )}

          {semanticLoading && (
            <div role="status" aria-live="polite" style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 10, color: '#94a3b8', fontSize: 14 }}>
              <span className="search-spinner search-spinner-muted" aria-hidden="true" />
              Looking through your invoices…
            </div>
          )}

          {semanticResults.length > 0 && (
            <div style={{ marginTop: 22 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#e2e8f0' }}>
                  {semanticResults.length} {semanticResults.length === 1 ? 'result' : 'results'}
                </h3>
                <span style={{ color: '#64748b', fontSize: 12 }}>Best matches for “{semanticQuery}”</span>
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
              {semanticResults.map((result) => {
                const customerMatch = customerNameMatchesQuery(result.customer_name, semanticQuery);
                return (
                <div key={result.doc_id} style={{ background: '#0b1425', border: customerMatch ? '1px solid #2563eb' : '1px solid #1f2937', borderRadius: 13, padding: 15, boxShadow: customerMatch ? 'inset 3px 0 #3b82f6' : undefined }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', fontWeight: 700 }}>
                        {result.customer_name || 'Unknown customer'}
                        {customerMatch && (
                          <span style={{ borderRadius: 999, padding: '3px 8px', background: 'rgba(37,99,235,0.16)', color: '#93c5fd', fontSize: 11, fontWeight: 700 }}>
                            Customer match
                          </span>
                        )}
                      </div>
                      <div style={{ marginTop: 4, color: '#94a3b8', fontSize: 13 }}>
                        {result.invoice_number ? `Invoice ${result.invoice_number}` : 'No invoice number'}
                      </div>
                    </div>
                    <div style={{ color: '#93c5fd', fontSize: 13, fontWeight: 700 }}>
                      {Math.max(0, Math.min(100, Number(result.score) * 100)).toFixed(1)}% similarity
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12, color: '#cbd5e1', fontSize: 13 }}>
                    <span>Total: {result.total === null ? '—' : formatCurrency(Number(result.total))}</span>
                    <span aria-hidden="true" style={{ color: '#475569' }}>·</span>
                    <span>Status: {result.validation_status || 'Unknown'}</span>
                  </div>
                </div>
                );
              })}
              </div>
            </div>
          )}

          {!semanticLoading && !semanticError && semanticHasSearched && semanticResults.length === 0 && (
            <div role="status" style={{ marginTop: 18, border: '1px dashed #334155', borderRadius: 12, padding: '20px 16px', textAlign: 'center' }}>
              <div style={{ color: '#e2e8f0', fontWeight: 700 }}>No matching invoices found</div>
              <div style={{ marginTop: 5, color: '#94a3b8', fontSize: 13 }}>Try another customer name, invoice number, or search phrase.</div>
            </div>
          )}

          {!semanticLoading && !semanticError && !semanticHasSearched && (
            <div style={{ marginTop: 16, color: '#64748b', fontSize: 12 }}>
              Tip: customer name matches are highlighted at the top of your results.
            </div>
          )}
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, marginBottom: 26 }}>
          {[
            { label: 'Total Processed', value: analytics.total_processed, accent: '#60a5fa' },
            { label: 'Success Rate', value: `${analytics.success_rate}%`, accent: '#34d399' },
            { label: 'Failed Extractions', value: analytics.failed_count, accent: '#f87171' },
            { label: 'Avg Latency', value: analytics.avg_latency, accent: '#a78bfa' },
          ].filter((card) => !failedHistoryCleared || card.label !== 'Failed Extractions').map((card) => (
            <div key={card.label} style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 18, padding: 22 }}>
              <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>{card.label}</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: card.accent }}>{card.value}</div>
            </div>
          ))}
        </section>

        <section style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 18, padding: 22, marginBottom: 26 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 22 }}>Weekly Processing Volume</h2>
            <span style={{ color: '#94a3b8', fontSize: 13 }}>Last 7 days · {weeklyTotal} {weeklyTotal === 1 ? 'document' : 'documents'}</span>
          </div>
          {weeklyTotal === 0 && (
            <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>
              No documents processed in the last 7 days.
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'end', gap: 12, minHeight: 180, paddingTop: 6 }}>
            {analytics.weekly_volume.map((entry) => (
              <div key={entry.date} title={`${entry.date}: ${entry.count} processed`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div aria-label={`${entry.date}: ${entry.count} documents processed`} style={{ width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'end', alignItems: 'center', minHeight: 140 }}>
                  <span style={{ color: '#cbd5e1', fontSize: 12, marginBottom: 5 }}>{entry.count}</span>
                  <div style={{ width: '100%', maxWidth: 36, height: entry.count === 0 ? 2 : `${Math.max(8, (entry.count / weeklyMaximum) * 120)}px`, background: entry.count === 0 ? '#334155' : 'linear-gradient(180deg, #60a5fa, #2563eb)', borderRadius: '8px 8px 0 0' }} />
                </div>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>{entry.day}</div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)', gap: 18 }}>
          <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 18, padding: 22 }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 22 }}>Upload Document</h2>
            <label style={{ display: 'block', border: '1px dashed #334155', borderRadius: 12, background: '#020817', padding: 22, textAlign: 'center', color: '#cbd5e1', cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{selectedFile ? selectedFile.name : 'Choose a file to process'}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>PDF, TXT, CSV, XLS, XLSX, PNG, JPG, JPEG</div>
              <input type="file" accept=".pdf,.txt,.csv,.xls,.xlsx,.png,.jpg,.jpeg" style={{ display: 'none' }} onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
            </label>

            <button onClick={handleUpload} disabled={uploadLoading || !selectedFile} style={{ width: '100%', marginTop: 16, background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 18px', fontWeight: 700, cursor: !uploadLoading && !!selectedFile ? 'pointer' : 'not-allowed' }}>
              {uploadLoading ? 'Processing...' : 'Process Document'}
            </button>

            {uploadStatus && (
              <div style={{ marginTop: 12, color: '#93c5fd', background: 'rgba(59,130,246,0.08)', borderRadius: 10, padding: '10px 12px', fontSize: 14 }}>
                {uploadStatus}
              </div>
            )}
          </div>

          <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 18, padding: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 22 }}>Recent Documents</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {failedDocumentsCount > 0 && (
                  <button
                    onClick={() =>
                      {
                        setDocuments((currentDocuments) =>
                          currentDocuments.filter(
                            (document) => document.status?.toLowerCase() !== 'failed',
                          ),
                        );
                        setFailedHistoryCleared(true);
                      }
                    }
                    title="Hide failed entries and their count from this dashboard view. Stored documents are not deleted."
                    style={{ background: '#0f172a', color: '#f8fafc', border: '1px solid #334155', borderRadius: 10, padding: '10px 12px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Clear failed ({failedDocumentsCount})
                  </button>
                )}
                {documents.length > 0 && (
                  <button
                    onClick={() => setDocuments([])}
                    title="Clear the list from this dashboard view. Stored documents are not deleted."
                    style={{ background: '#0f172a', color: '#f8fafc', border: '1px solid #334155', borderRadius: 10, padding: '10px 12px', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Clear list
                  </button>
                )}
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Filter by customer..."
                  style={{ minWidth: 180, padding: '10px 12px', borderRadius: 10, border: '1px solid #334155', background: '#020817', color: '#f8fafc' }}
                />
                <button onClick={handleSearch} style={{ background: '#0f172a', color: '#f8fafc', border: '1px solid #334155', borderRadius: 10, padding: '10px 12px', fontWeight: 600, cursor: 'pointer' }}>
                  Search
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {documents.length === 0 ? (
                <div style={{ padding: 18, color: '#94a3b8', border: '1px dashed #334155', borderRadius: 12 }}>No documents found.</div>
              ) : (
                documents.map((doc) => {
                  const customer = doc.structured_data?.customer_name || doc.customer_name || 'Unknown customer';
                  const invoiceNumber = doc.structured_data?.invoice_number || doc.invoice_number;
                  const total = doc.structured_data?.total ?? doc.total;
                  const status = (doc.validation_status || doc.status || 'UNKNOWN').toString().toUpperCase();

                  return (
                    <div key={doc.doc_id || customer} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, background: '#0f172a', border: '1px solid #1f2937', borderRadius: 12, padding: '12px 14px', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{invoiceNumber ? `${customer} • ${invoiceNumber}` : customer}</div>
                        <div style={{ color: '#94a3b8', fontSize: 12 }}>{status}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 700, color: '#93c5fd' }}>{formatCurrency(Number(total ?? 0))}</span>
                        <span style={{ padding: '5px 8px', borderRadius: 999, background: status === 'VALID' ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)', color: status === 'VALID' ? '#6ee7b7' : '#fca5a5', fontSize: 12, fontWeight: 700 }}>
                          {status === 'VALID' ? 'Valid' : 'Review'}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}