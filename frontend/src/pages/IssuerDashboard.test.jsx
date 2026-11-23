import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import IssuerDashboard from './IssuerDashboard';

// Mock the hooks
jest.mock('../hooks/useFreighter', () => ({
  useAuth: jest.fn()
}));

jest.mock('../hooks/useVaccination', () => ({
  useVaccination: jest.fn()
}));

import { useAuth } from '../hooks/useFreighter';
import { useVaccination } from '../hooks/useVaccination';

describe('IssuerDashboard', () => {
  const mockConnect = jest.fn();
  const mockIssueVaccination = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  describe('when not connected', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: null, role: null, connect: mockConnect });
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: false });
    });

    it('should show connect wallet prompt', () => {
      render(<IssuerDashboard />);

      expect(screen.getByText('Connect your issuer wallet.')).toBeInTheDocument();
    });

    it('should show connect wallet button', () => {
      render(<IssuerDashboard />);

      expect(screen.getByRole('button', { name: /Connect issuer wallet/i })).toBeInTheDocument();
    });

    it('should call connect when button is clicked', async () => {
      render(<IssuerDashboard />);

      const button = screen.getByRole('button', { name: /Connect issuer wallet/i });
      await userEvent.click(button);

      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('when connected but not issuer', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: 'G1234567890', role: 'user', connect: mockConnect });
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: false });
    });

    it('should show access denied message', () => {
      render(<IssuerDashboard />);

      expect(screen.getByText('Access denied: issuer role required.')).toBeInTheDocument();
    });
  });

  describe('when connected as issuer', () => {
    beforeEach(() => {
      useAuth.mockReturnValue({ publicKey: 'G1234567890', role: 'issuer', connect: mockConnect });
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: false });
    });

    it('should render form fields', () => {
      render(<IssuerDashboard />);

      expect(screen.getByLabelText('Patient Stellar Address')).toBeInTheDocument();
      expect(screen.getByLabelText('Vaccine Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Date Administered')).toBeInTheDocument();
    });

    it('should show submit button', () => {
      render(<IssuerDashboard />);

      expect(screen.getByRole('button', { name: /Issue Vaccination NFT/i })).toBeInTheDocument();
    });

    it('should show error for invalid Stellar address', async () => {
      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      
      // Use fireEvent instead of userEvent.type to avoid act() warnings
      fireEvent.change(addressInput, { target: { value: 'invalid-address' } });
      fireEvent.blur(addressInput);

      expect(await screen.findByText('Must be a valid Stellar public key (G…, 56 chars)')).toBeInTheDocument();
    });

    it('should show error for empty vaccine name', async () => {
      render(<IssuerDashboard />);

      const vaccineInput = screen.getByLabelText('Vaccine Name');
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });
      fireEvent.change(vaccineInput, { target: { value: '' } });
      fireEvent.blur(vaccineInput);

      expect(await screen.findByText('Vaccine name is required')).toBeInTheDocument();
    });

    it('should show error for future date', async () => {
      render(<IssuerDashboard />);

      const dateInput = screen.getByLabelText('Date Administered');
      fireEvent.change(dateInput, { target: { value: '2099-01-01' } });
      fireEvent.blur(dateInput);

      expect(await screen.findByText('Date cannot be in the future')).toBeInTheDocument();
    });

    it('should disable submit button when loading', () => {
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: true });

      render(<IssuerDashboard />);

      const submitButton = screen.getByRole('button', { name: /Minting…/i });
      expect(submitButton).toBeDisabled();
    });

    it('should show loading text when loading', () => {
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus: jest.fn().mockResolvedValue(true), loading: true });

      render(<IssuerDashboard />);

      expect(screen.getByText('Minting…')).toBeInTheDocument();
    });

    it('should call issueVaccination on form submission', async () => {
      mockIssueVaccination.mockResolvedValue(true);

      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      const vaccineInput = screen.getByLabelText('Vaccine Name');
      const dateInput = screen.getByLabelText('Date Administered');

      fireEvent.change(addressInput, { target: { value: 'G12345678901234567890123456789012345678901234567890123456' } });
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });
      fireEvent.change(dateInput, { target: { value: '2024-01-15' } });

      const submitButton = screen.getByRole('button', { name: /Issue Vaccination NFT/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalledWith({
          patient_address: 'G12345678901234567890123456789012345678901234567890123456',
          vaccine_name: 'COVID-19',
          date_administered: '2024-01-15'
        });
      });
    });

    it('should clear in-memory fields and persisted draft after successful issuance', async () => {
      mockIssueVaccination.mockResolvedValue(true);

      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      const vaccineInput = screen.getByLabelText('Vaccine Name');
      const dateInput = screen.getByLabelText('Date Administered');

      fireEvent.change(addressInput, { target: { value: 'G12345678901234567890123456789012345678901234567890123456' } });
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });
      fireEvent.change(dateInput, { target: { value: '2024-01-15' } });

      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));

      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(addressInput).toHaveValue('');
        expect(vaccineInput).toHaveValue('');
        expect(dateInput).toHaveValue('');
      });

      const persisted = Object.keys(sessionStorage)
        .filter((key) => key.toLowerCase().includes('draft'))
        .map((key) => sessionStorage.getItem(key))
        .join(' ');
      expect(persisted).not.toContain('G12345678901234567890123456789012345678901234567890123456');
      expect(persisted).not.toContain('COVID-19');
    });

    it('should preserve user-entered values when issuance fails', async () => {
      mockIssueVaccination.mockRejectedValue(new Error('Network error'));

      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      const vaccineInput = screen.getByLabelText('Vaccine Name');
      const dateInput = screen.getByLabelText('Date Administered');

      fireEvent.change(addressInput, { target: { value: 'G12345678901234567890123456789012345678901234567890123456' } });
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });
      fireEvent.change(dateInput, { target: { value: '2024-01-15' } });

      fireEvent.click(screen.getByRole('button', { name: /Issue Vaccination NFT/i }));

      await waitFor(() => {
        expect(mockIssueVaccination).toHaveBeenCalled();
      });

      expect(addressInput).toHaveValue('G12345678901234567890123456789012345678901234567890123456');
      expect(vaccineInput).toHaveValue('COVID-19');
      expect(dateInput).toHaveValue('2024-01-15');
    });

    it('should not persist patient-sensitive data in drafts', async () => {
      render(<IssuerDashboard />);

      const addressInput = screen.getByLabelText('Patient Stellar Address');
      const vaccineInput = screen.getByLabelText('Vaccine Name');

      fireEvent.change(addressInput, { target: { value: 'G12345678901234567890123456789012345678901234567890123456' } });
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });

      const persisted = Object.keys(sessionStorage)
        .filter((key) => key.toLowerCase().includes('draft'))
        .map((key) => sessionStorage.getItem(key))
        .join(' ');
      expect(persisted).not.toContain('G12345678901234567890123456789012345678901234567890123456');
    });

    it('should show loading state while checking issuer status', () => {
      useVaccination.mockReturnValue({
        issueVaccination: mockIssueVaccination,
        checkIssuerStatus: jest.fn(() => new Promise(() => {})),
        loading: false
      });

      render(<IssuerDashboard />);

      expect(screen.getByText(/Checking issuer status/i)).toBeInTheDocument();
    });

    it('should show error state with retry when issuer status check fails', async () => {
      const checkIssuerStatus = jest.fn().mockRejectedValue(new Error('Network error'));
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus, loading: false });

      render(<IssuerDashboard />);

      expect(await screen.findByText(/Unable to verify issuer status/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });

    it('should preserve form state when retrying a failed status check', async () => {
      const checkIssuerStatus = jest.fn().mockRejectedValue(new Error('Network error'));
      useVaccination.mockReturnValue({ issueVaccination: mockIssueVaccination, checkIssuerStatus, loading: false });

      render(<IssuerDashboard />);

      const vaccineInput = screen.getByLabelText('Vaccine Name');
      fireEvent.change(vaccineInput, { target: { value: 'COVID-19' } });

      const retryButton = await screen.findByRole('button', { name: /Retry/i });
      checkIssuerStatus.mockResolvedValue(true);
      fireEvent.click(retryButton);

      await waitFor(() => {
        expect(checkIssuerStatus).toHaveBeenCalledTimes(2);
      });

      expect(screen.getByLabelText('Vaccine Name')).toHaveValue('COVID-19');
    });
  });
});