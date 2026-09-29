from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User, OperatorProfile, DriverProfile, RankCode
from transport.models import Trip, Rank, Destination, Route, Announcement, DriverComplaint, TripFlag


class OperatorRequirementsTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.rank_code = RankCode.objects.create(
            code='RANK-001',
            association_name='Empangeni Association',
            operating_region='King Cetshwayo',
        )
        self.operator_user = User.objects.create_user(
            username='operator_demo',
            phone='0820000000',
            password='themba123',
            role='operator',
            first_name='Operator',
            last_name='User',
        )
        self.operator_profile = OperatorProfile.objects.create(
            user=self.operator_user,
            association=self.rank_code,
        )

        self.driver_user = User.objects.create_user(
            username='driver_demo',
            phone='0821111111',
            password='themba123',
            role='driver',
            first_name='Driver',
            last_name='User',
        )
        self.driver_profile = DriverProfile.objects.create(
            user=self.driver_user,
            license_number='DL-2201',
            id_number='9001010001082',
            association=self.rank_code,
            status=DriverProfile.VerificationStatus.VERIFIED,
        )

        self.rank = Rank.objects.create(name='Empangeni Rank', area='Empangeni')
        self.destination = Destination.objects.create(name='KwaDlangezwa', area='KwaDlangezwa')
        self.route = Route.objects.create(
            departure=self.rank,
            destination=self.destination,
            fare=25.00,
            name='Empangeni to KwaDlangezwa',
        )
        self.trip = Trip.objects.create(
            operator=self.operator_profile,
            route=self.route,
            departure_date='2026-09-30',
            expected_departure_time='08:00:00',
            seat_capacity=15,
            status=Trip.Status.SCHEDULED,
            trip_code='EMP-9001',
            driver=self.driver_profile,
        )

    def test_operator_can_create_and_list_announcements(self):
        self.client.force_authenticate(user=self.operator_user)
        response = self.client.post(
            '/api/announcements/',
            {
                'title': 'Weather update',
                'message': 'Route is delayed due to rain.',
                'audience': 'all',
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertTrue(Announcement.objects.filter(title='Weather update').exists())

        list_response = self.client.get('/api/announcements/')
        self.assertEqual(list_response.status_code, 200)
        self.assertGreaterEqual(len(list_response.data), 1)

    def test_operator_can_view_extended_driver_information(self):
        self.client.force_authenticate(user=self.operator_user)
        response = self.client.get('/api/operator/drivers/')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertGreaterEqual(len(response.data), 1)
        self.assertIn('license_number', response.data[0])
        detail_response = self.client.get(f"/api/operator/drivers/{self.driver_profile.id}/")
        self.assertEqual(detail_response.status_code, 200, detail_response.content)
        self.assertEqual(detail_response.data['user']['phone'], '0821111111')
        self.assertEqual(detail_response.data['association']['association_name'], 'Empangeni Association')

    def test_operator_can_review_and_resolve_driver_complaints(self):
        complaint = DriverComplaint.objects.create(
            driver=self.driver_profile,
            trip=self.trip,
            raised_by=self.driver_user,
            category='delay',
            description='Driver arrived late at the pickup point.',
            status='open',
        )

        self.client.force_authenticate(user=self.operator_user)
        response = self.client.get('/api/operator/complaints/')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertGreaterEqual(len(response.data), 1)

        resolve_response = self.client.post(
            f'/api/operator/complaints/{complaint.id}/resolve/',
            {'status': 'resolved'},
            format='json',
        )
        self.assertEqual(resolve_response.status_code, 200, resolve_response.content)
        complaint.refresh_from_db()
        self.assertEqual(complaint.status, 'resolved')

    def test_operator_can_flag_a_trip(self):
        self.client.force_authenticate(user=self.operator_user)
        response = self.client.post(
            f'/api/my-trips/{self.trip.id}/flag/',
            {'category': 'delay', 'description': 'The trip was delayed due to a vehicle issue.'},
            format='json',
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertTrue(TripFlag.objects.filter(trip=self.trip, category='delay').exists())
