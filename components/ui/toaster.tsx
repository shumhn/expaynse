'use client';

import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="top-center"
      toastOptions={{
        classNames: {
          toast: 'bg-white border-emerald-500/20 shadow-lg',
          title: 'text-gray-900 font-semibold',
          description: 'text-gray-600',
          actionButton: 'bg-emerald-500 text-white hover:bg-emerald-500/90',
          cancelButton: 'bg-gray-100 text-gray-600',
          success: 'border-green-500/20',
          error: 'border-red-500/20',
          warning: 'border-yellow-500/30',
          info: 'border-emerald-500/30',
        },
      }}
      icons={{
        success: <span className="text-xl text-green-500">E</span>,
        error: <span className="text-xl text-red-500">E</span>,
        warning: <span className="text-xl text-yellow-500">E</span>,
        info: <span className="text-xl text-emerald-500">E</span>,
      }}
    />
  );
}
