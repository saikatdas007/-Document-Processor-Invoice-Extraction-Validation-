'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000'
).replace(/\/+$/, '');

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
  const accountInitial = session?.email.slice(0, 1).toUpperCase() ?? 'A';

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
    <main className="dashboard-app" id="overview">
      <aside className="dashboard-sidebar">
        <Link className="dashboard-brand" href="/" aria-label="Document Intelligence home">
          <span className="dashboard-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M7 3.75h7l4 4v12.5H7a2 2 0 0 1-2-2v-12.5a2 2 0 0 1 2-2Z" />
              <path d="M14 3.75v4h4M8.5 12h7M8.5 15.5h7" />
            </svg>
          </span>
          <span className="dashboard-brand-name">folio<span>flow</span></span>
        </Link>

        <div className="dashboard-workspace-label">WORKSPACE</div>
        <nav className="dashboard-nav" aria-label="Dashboard navigation">
          <a className="dashboard-nav-link is-active" href="#overview">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></svg>
            <span>Overview</span>
          </a>
          <a className="dashboard-nav-link" href="#documents">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" /><path d="M14 3.5v4h4M8.5 12h7M8.5 15.5h7" /></svg>
            <span>Documents</span>
            <span className="dashboard-nav-count">{documents.length}</span>
          </a>
          <a className="dashboard-nav-link" href="#search">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></svg>
            <span>Smart search</span>
          </a>
          <a className="dashboard-nav-link" href="#activity">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 19.5h16M6.5 16v-4M12 16V5.5M17.5 16v-7" /></svg>
            <span>Analytics</span>
          </a>
        </nav>

        <a className="dashboard-sidebar-upload" href="#upload">
          <span aria-hidden="true">+</span> Upload a document
        </a>

        <div className="dashboard-sidebar-footer">
          <div className="dashboard-security-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 3 5.5 5.7v5c0 4 2.7 7.5 6.5 8.8 3.8-1.3 6.5-4.8 6.5-8.8v-5L12 3Z" /><path d="m9 12 2 2 4-4" /></svg>
          </div>
          <strong>Your workspace is private</strong>
          <span>Documents are protected by secure access controls.</span>
        </div>
      </aside>

      <div className="dashboard-shell">
        <header className="dashboard-header">
          <div>
            <div className="dashboard-breadcrumb">Workspace <span>/</span> Overview</div>
            <h1>Document overview</h1>
            <p>Your invoices, activity, and insights in one place.</p>
          </div>

          <div className="dashboard-account">
            <div className="dashboard-account-avatar" aria-hidden="true">{accountInitial}</div>
            <div className="dashboard-account-copy">
              <strong>{session.email}</strong>
              <span>{session.role}</span>
            </div>
            <button className="dashboard-signout" onClick={handleLogout} aria-label="Sign out">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10M14 8l4 4-4 4M18 12H9" /></svg>
              <span>Sign out</span>
            </button>
          </div>
        </header>

        {logoutError && (
          <div className="dashboard-error" role="alert">
            {logoutError}
          </div>
        )}

        <section className="dashboard-panel semantic-panel" id="search">
          <div className="semantic-heading">
            <div className="semantic-title-row">
              <span className="semantic-heading-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9 12 3.5ZM19 15.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" /></svg>
              </span>
              <div className="semantic-title-copy">
              <h2>Find an invoice</h2>
              <span className="semantic-badge">AI POWERED</span>
              </div>
            </div>
            <p className="semantic-description">
              Search by customer name, invoice number, supplier, or billing details.
            </p>
          </div>
          <form className="semantic-form" onSubmit={handleSemanticSearch}>
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
                className="dashboard-button dashboard-button-quiet"
              >
                Clear
              </button>
            )}
            <button className="dashboard-button dashboard-button-primary" type="submit" disabled={semanticLoading || !semanticQuery.trim()}>
              {semanticLoading && <span className="search-spinner" aria-hidden="true" />}
              {semanticLoading ? 'Searching' : 'Search'}
            </button>
          </form>

          {semanticError && (
            <div className="dashboard-error" role="alert">
              {semanticError}
            </div>
          )}

          {semanticLoading && (
            <div className="semantic-loading" role="status" aria-live="polite">
              <span className="search-spinner search-spinner-muted" aria-hidden="true" />
              Looking through your invoices…
            </div>
          )}

          {semanticResults.length > 0 && (
            <div className="semantic-results">
              <div className="semantic-results-heading">
                <h3>
                  {semanticResults.length} {semanticResults.length === 1 ? 'result' : 'results'}
                </h3>
                <span>Best matches for “{semanticQuery}”</span>
              </div>
              <div className="semantic-result-list">
              {semanticResults.map((result) => {
                const customerMatch = customerNameMatchesQuery(result.customer_name, semanticQuery);
                return (
                <div key={result.doc_id} className={`semantic-result${customerMatch ? ' is-customer-match' : ''}`}>
                  <div className="semantic-result-top">
                    <div>
                      <div className="semantic-result-name">
                        {result.customer_name || 'Unknown customer'}
                        {customerMatch && (
                          <span className="semantic-match-badge">
                            Customer match
                          </span>
                        )}
                      </div>
                      <div className="semantic-result-invoice">
                        {result.invoice_number ? `Invoice ${result.invoice_number}` : 'No invoice number'}
                      </div>
                    </div>
                    <div className="semantic-result-score">
                      {Math.max(0, Math.min(100, Number(result.score) * 100)).toFixed(1)}% similarity
                    </div>
                  </div>
                  <div className="semantic-result-meta">
                    <span>Total: {result.total === null ? '—' : formatCurrency(Number(result.total))}</span>
                    <span aria-hidden="true">·</span>
                    <span>Status: {result.validation_status || 'Unknown'}</span>
                  </div>
                </div>
                );
              })}
              </div>
            </div>
          )}

          {!semanticLoading && !semanticError && semanticHasSearched && semanticResults.length === 0 && (
            <div className="dashboard-empty" role="status">
              <div>No matching invoices found</div>
              <div>Try another customer name, invoice number, or search phrase.</div>
            </div>
          )}

          {!semanticLoading && !semanticError && !semanticHasSearched && (
            <div className="semantic-tip">
              Tip: customer name matches are highlighted at the top of your results.
            </div>
          )}
        </section>

        <section className="dashboard-metrics" aria-label="Processing metrics">
          {[
            { label: 'Total Processed', value: analytics.total_processed, accent: '#60a5fa' },
            { label: 'Success Rate', value: `${analytics.success_rate}%`, accent: '#34d399' },
            { label: 'Failed Extractions', value: analytics.failed_count, accent: '#f87171' },
            { label: 'Avg Latency', value: analytics.avg_latency, accent: '#a78bfa' },
          ].filter((card) => !failedHistoryCleared || card.label !== 'Failed Extractions').map((card) => (
            <div key={card.label} className="dashboard-metric-card">
              <div className="metric-card-top">
                <span>{card.label}</span>
                <span className={`metric-icon ${card.label === 'Success Rate' ? 'metric-icon-green' : card.label === 'Failed Extractions' ? 'metric-icon-orange' : card.label === 'Avg Latency' ? 'metric-icon-violet' : 'metric-icon-blue'}`} aria-hidden="true">
                  {card.label === 'Success Rate' ? '✓' : card.label === 'Failed Extractions' ? '!' : card.label === 'Avg Latency' ? '◷' : '↗'}
                </span>
              </div>
              <div className="metric-card-value">{card.value}</div>
              <div className="metric-card-caption">{card.label === 'Failed Extractions' ? 'Need a closer look' : card.label === 'Success Rate' ? 'Invoices validated' : card.label === 'Avg Latency' ? 'Average processing time' : 'Across your workspace'}</div>
            </div>
          ))}
        </section>

        <section className="dashboard-panel activity-panel" id="activity">
          <div className="panel-heading-row">
            <div>
              <span className="panel-eyebrow">YOUR WORKSPACE</span>
              <h2>Processing activity</h2>
            </div>
            <span className="activity-period">Last 7 days <i /> {weeklyTotal} {weeklyTotal === 1 ? 'document' : 'documents'}</span>
          </div>
          {weeklyTotal === 0 && (
            <p className="activity-empty">
              No documents processed in the last 7 days.
            </p>
          )}
          <div className="activity-chart">
            {analytics.weekly_volume.map((entry) => (
              <div key={entry.date} title={`${entry.date}: ${entry.count} processed`} className="activity-day">
                <div className="activity-bar-track" aria-label={`${entry.date}: ${entry.count} documents processed`}>
                  <span>{entry.count}</span>
                  <div className="activity-bar" style={{ height: entry.count === 0 ? 2 : `${Math.max(8, (entry.count / weeklyMaximum) * 120)}px` }} />
                </div>
                <div className="activity-day-label">{entry.day}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="dashboard-operations-grid">
          <div className="dashboard-panel upload-panel" id="upload">
            <div className="panel-heading-row">
              <div>
                <span className="panel-eyebrow">GET STARTED</span>
                <h2>Upload invoice</h2>
              </div>
              <span className="upload-panel-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4" /></svg>
              </span>
            </div>
            <label className="upload-dropzone">
              <span className="upload-dropzone-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4" /></svg>
              </span>
              <strong>{selectedFile ? selectedFile.name : 'Choose a file to process'}</strong>
              <span>or click to browse your files</span>
              <small>PDF, TXT, CSV, XLS, XLSX, PNG, JPG, JPEG</small>
              <input type="file" accept=".pdf,.txt,.csv,.xls,.xlsx,.png,.jpg,.jpeg" onChange={(event) => setSelectedFile(event.target.files?.[0] || null)} />
            </label>

            <button className="dashboard-button dashboard-button-primary upload-submit" onClick={handleUpload} disabled={uploadLoading || !selectedFile}>
              {uploadLoading ? 'Processing invoice…' : 'Process invoice'}
            </button>

            {uploadStatus && (
              <div className="upload-status" role="status">
                {uploadStatus}
              </div>
            )}
          </div>

          <div className="dashboard-panel documents-panel" id="documents">
            <div className="documents-panel-heading">
              <div>
                <span className="panel-eyebrow">YOUR FILES</span>
                <h2>Recent documents</h2>
              </div>
              <div className="documents-actions">
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
                    className="dashboard-button dashboard-button-quiet"
                  >
                    Clear failed ({failedDocumentsCount})
                  </button>
                )}
                {documents.length > 0 && (
                  <button
                    onClick={() => setDocuments([])}
                    title="Clear the list from this dashboard view. Stored documents are not deleted."
                    className="dashboard-button dashboard-button-quiet"
                  >
                    Clear list
                  </button>
                )}
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Filter by customer..."
                  aria-label="Filter documents by customer"
                />
                <button onClick={handleSearch} className="dashboard-button dashboard-button-quiet">
                  Search
                </button>
              </div>
            </div>

            <div className="documents-list">
              {documents.length === 0 ? (
                <div className="dashboard-empty">
                  <span className="empty-doc-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" /><path d="M14 3.5v4h4M8.5 12h7M8.5 15.5h4" /></svg>
                  </span>
                  <strong>No documents yet</strong>
                  <span>Upload your first invoice to see it here.</span>
                </div>
              ) : (
                documents.map((doc) => {
                  const customer = doc.structured_data?.customer_name || doc.customer_name || 'Unknown customer';
                  const invoiceNumber = doc.structured_data?.invoice_number || doc.invoice_number;
                  const total = doc.structured_data?.total ?? doc.total;
                  const status = (doc.validation_status || doc.status || 'UNKNOWN').toString().toUpperCase();

                  return (
                    <div key={doc.doc_id || customer} className="document-row">
                      <span className="document-file-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none"><path d="M7 3.5h7l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" /><path d="M14 3.5v4h4M8.5 12h7M8.5 15.5h4" /></svg>
                      </span>
                      <div className="document-row-copy">
                        <strong>{invoiceNumber ? `${customer} · ${invoiceNumber}` : customer}</strong>
                        <span>{status}</span>
                      </div>
                      <span className="document-row-total">{formatCurrency(Number(total ?? 0))}</span>
                      <span className={`document-status ${status === 'VALID' ? 'is-valid' : 'is-review'}`}>
                        {status === 'VALID' ? 'Valid' : 'Review'}
                      </span>
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