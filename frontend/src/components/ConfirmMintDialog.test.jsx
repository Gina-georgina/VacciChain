import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmMintDialog from './ConfirmMintDialog';

describe('ConfirmMintDialog', () => {
  const mockRecord = {
    patient_address: 'G12345678901234567890123456789012345678901234567890123456',
    vaccine_name: 'COVID-19',
    date_administered: '2024-01-15'
  };
  const mockOnConfirm = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders dialog with record details', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    
    expect(screen.getByText(/Confirm Vaccination Mint/i)).toBeInTheDocument();
    expect(screen.getByText(/Patient/i)).toBeInTheDocument();
    expect(screen.getByText(/Vaccine/i)).toBeInTheDocument();
    expect(screen.getByText(/Date/i)).toBeInTheDocument();
  });

  it('displays patient address', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    expect(screen.getByText(/G12345678/i)).toBeInTheDocument();
  });

  it('displays vaccine name', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    expect(screen.getByText(/COVID-19/i)).toBeInTheDocument();
  });

  it('displays date administered', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    expect(screen.getByText(/2024-01-15/i)).toBeInTheDocument();
  });

  it('shows confirm button', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    expect(screen.getByRole('button', { name: /Confirm & Mint/i })).toBeInTheDocument();
  });

  it('shows cancel button', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /Confirm & Mint/i }));
    expect(mockOnConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is clicked', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('has correct role and aria attributes', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    const overlay = screen.getByRole('dialog');
    expect(overlay).toHaveAttribute('aria-modal', 'true');
  });

  it('confirm button has autoFocus', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    const confirmButton = screen.getByRole('button', { name: /Confirm & Mint/i });
    expect(confirmButton).toHaveFocus();
  });

  it('prevents Enter key from triggering default behavior', () => {
    render(<ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />);
    const overlay = screen.getByRole('dialog');
    const preventDefault = jest.fn();
    fireEvent.keyDown(overlay, { key: 'Enter', preventDefault });
    expect(preventDefault).not.toHaveBeenCalled(); // Enter is allowed to propagate
  });

  it('disables confirm and blocks submission when wallet network mismatches', () => {
    render(
      <ConfirmMintDialog
        record={mockRecord}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        networkMismatch
        configuredNetwork="TESTNET"
        walletNetwork="PUBLIC"
      />
    );

    const confirmButton = screen.getByRole('button', { name: /Confirm & Mint/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(confirmButton);
    expect(mockOnConfirm).not.toHaveBeenCalled();

    expect(screen.getByRole('alert')).toHaveTextContent(/network mismatch/i);
    expect(screen.getByText(/TESTNET/i)).toBeInTheDocument();
    expect(screen.getByText(/PUBLIC/i)).toBeInTheDocument();
    expect(screen.getByText(/switch your wallet/i)).toBeInTheDocument();
  });

  it('announces the mint result through a live region', () => {
    const { rerender } = render(
      <ConfirmMintDialog record={mockRecord} onConfirm={mockOnConfirm} onCancel={mockOnCancel} />
    );

    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toHaveTextContent('');

    rerender(
      <ConfirmMintDialog
        record={mockRecord}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        mintResult={{ status: 'success', message: 'Vaccination minted successfully.' }}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent(/minted successfully/i);
  });

  it('announces mint errors through an assertive live region', () => {
    render(
      <ConfirmMintDialog
        record={mockRecord}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        mintResult={{ status: 'error', message: 'Mint failed. Please try again.' }}
      />
    );

    const alertRegion = screen.getByRole('alert');
    expect(alertRegion).toHaveAttribute('aria-live', 'assertive');
    expect(alertRegion).toHaveTextContent(/mint failed/i);
  });

  it('does not duplicate announcements when the same result is re-rendered', () => {
    const mintResult = { status: 'success', message: 'Vaccination minted successfully.' };
    const { rerender } = render(
      <ConfirmMintDialog
        record={mockRecord}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        mintResult={mintResult}
      />
    );

    const firstAnnouncement = screen.getByRole('status').textContent;

    rerender(
      <ConfirmMintDialog
        record={mockRecord}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
        mintResult={{ ...mintResult }}
      />
    );

    expect(screen.getByRole('status').textContent).toBe(firstAnnouncement);
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});